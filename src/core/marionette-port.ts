// SPDX-License-Identifier: EUPL-1.2
/**
 * Marionette port probe.
 *
 * Gecko's Marionette control channel binds `127.0.0.1:2828` when a
 * Firefox / ForgeFresh / Hominis instance is launched with
 * `-marionette`. The `fireforge test` harness spawns the browser with
 * that flag, so any test run needs the port to be free at start.
 *
 * Motivating case (2026-04-21 eval, Finding #20): an interrupted
 * `fireforge test --headless` left an orphan
 * `ForgeFresh.app/Contents/MacOS/forgefresh -marionette` process
 * listening on 2828 with parent PID 1. The next `fireforge test` run
 * — in a *different* FireForge project — failed immediately with a
 * Marionette bind error, and FireForge's generic "re-run build" hint
 * did not mention the stale listener. The probe in this module runs
 * before every test launch, detects when the port is held, and —
 * when the holder is a browser process (by command-line `-marionette`
 * flag or by basename matching a known browser binary) — throws a
 * targeted `GeneralError` naming the PID and the exact `kill` command
 * to run.
 *
 * Cross-platform implementation:
 *   - POSIX (macOS / Linux): `lsof -i tcp:<port> -P -n -sTCP:LISTEN`
 *   - Windows: `Get-NetTCPConnection` via PowerShell, then
 *     `Get-Process` to resolve the PID into a command line.
 *
 * Both paths tolerate missing tooling: if `lsof` / PowerShell isn't
 * installed, the probe returns `{ inUse: false }` rather than failing
 * the test run itself — the probe is a best-effort friendliness
 * check, not a prerequisite.
 */
import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { getPlatform } from '../utils/platform.js';
import { exec } from '../utils/process.js';

/** Default Marionette control port set by `-marionette`. */
export const DEFAULT_MARIONETTE_PORT = 2828;

/** Basenames of browser binaries that ship a Marionette listener. */
const BROWSER_BASENAMES = new Set([
  'firefox',
  'firefox-bin',
  'firefox-esr',
  'forgefresh',
  'hominis',
  'thunderbird',
]);

/**
 * Information about a process holding the Marionette port.
 */
export interface MarionettePortHolder {
  /** OS process ID. */
  pid: number;
  /** Process basename (e.g. `forgefresh`, `firefox`). */
  command: string;
  /**
   * Full command line the holder was launched with, when the probe
   * can recover it. `lsof` by itself only returns the basename, so
   * POSIX callers see `command === commandLine`; Windows callers
   * recover the full command line via `Get-Process`. Used to detect
   * the `-marionette` flag, which positively identifies a stale
   * browser rather than an unrelated listener.
   */
  commandLine: string;
}

/**
 * Result of a Marionette port probe.
 */
export interface MarionettePortProbeResult {
  /** True when something is listening on the probed port. */
  inUse: boolean;
  /** Details about the holder, when the probe recovered them. */
  holder?: MarionettePortHolder;
}

/**
 * Returns `true` when the holder's command basename or command-line
 * flags clearly identify it as a Firefox-family browser with
 * Marionette enabled. Used to decide whether to raise a targeted
 * "stale browser on port" error vs a soft "unrelated listener"
 * warning.
 *
 * Includes the operator-provided `binaryName` from `fireforge.json`
 * so a fork that ships under a custom name (e.g. Hominis'
 * `hominis-nightly`) is still recognised as a browser.
 */
function isBrowserHolder(holder: MarionettePortHolder, binaryName?: string): boolean {
  if (/\s-marionette(?:\s|$)/.test(holder.commandLine)) {
    return true;
  }
  const name = holder.command.toLowerCase();
  if (BROWSER_BASENAMES.has(name)) return true;
  if (binaryName && name === binaryName.toLowerCase()) return true;
  return false;
}

/**
 * Probes the given port with `lsof` (macOS / Linux). Returns
 * `{ inUse: false }` when the port is free OR when `lsof` is not
 * available — the probe is a best-effort courtesy check, so a
 * missing tool must not block the test run.
 */
async function probeWithLsof(port: number): Promise<MarionettePortProbeResult> {
  try {
    // `-sTCP:LISTEN` filters to listeners only; `-P -n` avoids
    // service/host lookups (faster + no DNS-dependent flakiness).
    // `-Fpcn` emits a machine-readable format: one field per line,
    // with `p<pid>`, `c<command>`, `n<name>` records.
    const result = await exec('lsof', ['-i', `tcp:${port}`, '-P', '-n', '-sTCP:LISTEN', '-Fpcn']);
    // `lsof` exits 1 when no matches — that's "port is free", not an
    // error. We key off stdout shape instead of exit code.
    const stdout = result.stdout;
    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    let pid = -1;
    let command = '';
    for (const line of lines) {
      if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
      else if (line.startsWith('c')) command = line.slice(1);
    }
    if (!Number.isFinite(pid) || pid < 0 || command === '') {
      return { inUse: false };
    }
    // `lsof` does not return the full command line; `ps` does. A
    // missing `ps` (exotic Linux container) falls back to `command`
    // alone, which is still enough to match `BROWSER_BASENAMES`.
    let commandLine = command;
    try {
      const psResult = await exec('ps', ['-p', String(pid), '-o', 'args=']);
      const psLine = psResult.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (psLine) commandLine = psLine.trim();
    } catch {
      // ps not available — keep the basename.
    }
    return { inUse: true, holder: { pid, command, commandLine } };
  } catch (error: unknown) {
    // `lsof` missing, or stdout parse failed. Treat as "unknown" ⇒
    // port probe is silently skipped.
    const message = toError(error).message;
    if (/ENOENT|not found|command not found/i.test(message)) {
      return { inUse: false };
    }
    return { inUse: false };
  }
}

/**
 * Probes the given port with PowerShell (Windows). Uses
 * `Get-NetTCPConnection` to find listeners, then `Get-Process -Id`
 * to resolve the process name and command line. Gracefully degrades
 * when PowerShell is unavailable.
 */
async function probeWithPowerShell(port: number): Promise<MarionettePortProbeResult> {
  const script =
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue;` +
    ` if ($null -eq $c) { exit 0 }` +
    ` $p = Get-Process -Id $c[0].OwningProcess -ErrorAction SilentlyContinue;` +
    ` if ($null -eq $p) { exit 0 }` +
    ` $w = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue;` +
    ` Write-Output ("PID=" + $p.Id);` +
    ` Write-Output ("NAME=" + $p.ProcessName);` +
    ` if ($w -ne $null) { Write-Output ("CMD=" + $w.CommandLine) }`;
  try {
    const result = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    const stdout = result.stdout;
    const pidMatch = /PID=(\d+)/.exec(stdout);
    const nameMatch = /NAME=([^\r\n]+)/.exec(stdout);
    if (!pidMatch || !nameMatch) return { inUse: false };
    const pid = parseInt(pidMatch[1] ?? '', 10);
    const command = (nameMatch[1] ?? '').trim();
    const cmdMatch = /CMD=([^\r\n]+)/.exec(stdout);
    const commandLine = cmdMatch ? (cmdMatch[1] ?? '').trim() : command;
    if (!Number.isFinite(pid) || command === '') return { inUse: false };
    return { inUse: true, holder: { pid, command, commandLine } };
  } catch {
    return { inUse: false };
  }
}

/**
 * Probes whether the Marionette port is currently bound by a
 * listener. The probe is best-effort: missing tooling returns
 * `{ inUse: false }` without failing.
 *
 * @param port - Port to probe (default {@link DEFAULT_MARIONETTE_PORT}).
 */
export async function probeMarionettePort(
  port: number = DEFAULT_MARIONETTE_PORT
): Promise<MarionettePortProbeResult> {
  let platform: ReturnType<typeof getPlatform>;
  try {
    platform = getPlatform();
  } catch {
    return { inUse: false };
  }
  if (platform === 'darwin' || platform === 'linux') {
    return probeWithLsof(port);
  }
  // win32
  return probeWithPowerShell(port);
}

/**
 * Raises a targeted {@link GeneralError} when the Marionette port
 * is held by a browser process; raises a softer warning-shaped
 * error when the holder is unrelated (so the operator still sees
 * a useful signal but can decide whether to wait it out).
 *
 * @param port - Port to probe (default {@link DEFAULT_MARIONETTE_PORT}).
 * @param options - Extra context for the error message (the project's
 *   `binaryName` is used to recognise fork-branded browser binaries).
 */
export async function assertMarionettePortAvailable(
  port: number = DEFAULT_MARIONETTE_PORT,
  options: { binaryName?: string } = {}
): Promise<void> {
  const probe = await probeMarionettePort(port);
  if (!probe.inUse || !probe.holder) return;

  const holder = probe.holder;
  if (isBrowserHolder(holder, options.binaryName)) {
    const killHint =
      process.platform === 'win32'
        ? `Stop-Process -Id ${holder.pid} -Force`
        : `kill ${holder.pid}  # or "kill -9 ${holder.pid}" if it doesn't exit`;
    throw new GeneralError(
      `Marionette port ${port} is already in use by ${holder.command} (PID ${holder.pid}). ` +
        `This is usually a browser left running by a previously interrupted "fireforge test" run. ` +
        `Kill it with "${killHint}", then retry. ` +
        `(If you expected ${holder.command} to be running on ${port}, stop it manually or pass ` +
        `"--marionette-port <port>" to launch mach test on a different port.)`
    );
  }

  // Non-browser holder: mach test will still fail to bind, but the
  // cause is not a stale FireForge-launched browser. Flag it
  // explicitly so the operator can decide what to do instead of
  // getting mach's bind error with no FireForge context.
  throw new GeneralError(
    `Marionette port ${port} is already in use by ${holder.command} (PID ${holder.pid}). ` +
      `This is not a FireForge-launched browser; stop the holder process or free the port before rerunning.`
  );
}
