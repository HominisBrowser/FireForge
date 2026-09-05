// SPDX-License-Identifier: EUPL-1.2
/**
 * Marionette port probe.
 *
 * Gecko's Marionette control channel binds `127.0.0.1:2828` when a browser
 * is launched with `-marionette`. The `fireforge test` harness spawns the
 * browser with that flag, so any test run needs the port free at start.
 *
 * An interrupted `fireforge test` can leave an orphan browser process
 * listening on 2828 with parent PID 1, and the next test run (possibly in a
 * *different* FireForge project) then fails with a bare Marionette bind
 * error. This probe runs before every test launch and detects when the port
 * is held. When the holder is a browser process (by command-line
 * `-marionette` flag or by basename matching a known browser binary), it
 * throws a targeted `GeneralError` naming the PID and the exact `kill`
 * command to run.
 *
 * Cross-platform implementation:
 *   - POSIX (macOS / Linux): `lsof -i tcp:<port> -P -n -sTCP:LISTEN`
 *   - Windows: `Get-NetTCPConnection` via PowerShell, then `Get-Process` to
 *     resolve the PID into a command line.
 *
 * Both paths tolerate missing tooling: if `lsof` / PowerShell is not
 * installed the probe returns `{ inUse: false }` rather than failing the
 * test run. It is a best-effort friendliness check rather than a
 * prerequisite.
 */
import { PreflightRefusalError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { getPlatform, type Platform } from '../utils/platform.js';
import { exec } from '../utils/process.js';
import { formatPsDuration, parsePsDuration } from '../utils/ps-duration.js';

/** Default Marionette control port set by `-marionette`. */
export const DEFAULT_MARIONETTE_PORT = 2828;

/** Basenames of browser binaries that ship a Marionette listener. */
const BROWSER_BASENAMES = new Set([
  'firefox',
  'firefox-bin',
  'firefox-esr',
  'forgefresh',
  'mybrowser',
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
   * POSIX callers see `command === commandLine`. Windows callers
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

/** A Firefox-family process launched from this project's built bundle. */
export interface RunningBundleProcess {
  pid: number;
  commandLine: string;
  /**
   * Elapsed wall-clock seconds since the process started, from `ps
   * etime=`. `NaN` when the field was absent or unparseable, and callers must
   * omit the clause rather than print a zero, because "started 0s ago" is
   * exactly the wrong attribution for a peer session's long-lived browser.
   */
  elapsedSeconds: number;
}

/**
 * Finds browser processes whose command line names the exact launchable
 * binary from this project's objdir. Unlike the Marionette-port probe, this
 * also catches a wedged browser that survived a harness timeout but no longer
 * owns the control port. Best-effort: unavailable process-list tooling yields
 * an empty result rather than blocking tests.
 */
async function findRunningBundleProcesses(
  launchableBinary: string
): Promise<RunningBundleProcess[]> {
  try {
    if (process.platform === 'win32') {
      const escapedPath = launchableBinary.replaceAll("'", "''");
      const script =
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escapedPath}' } | ` +
        'ForEach-Object { Write-Output ("$($_.ProcessId) ' +
        '$([int]((Get-Date) - $_.CreationDate).TotalSeconds)s $($_.CommandLine)") }';
      const result = await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      return parseProcessList(result.stdout, launchableBinary);
    }

    // `etime=` is what makes the refusal attributable on a shared checkout:
    // a browser that started as your run was finishing is not yours.
    const result = await exec('ps', ['-axo', 'pid=,etime=,args=']);
    return parseProcessList(result.stdout, launchableBinary);
  } catch {
    return [];
  }
}

/**
 * Pure parser kept exported so platform output handling is
 * regression-testable.
 *
 * Reads `pid etime args` where the middle field is a `ps` duration. The
 * elapsed field is parsed optimistically: a listing produced without
 * `etime=` still parses, with the duration reported as `NaN` and the whole
 * second field folded back into the command line, so a caller that lost the
 * column degrades to the old behaviour instead of dropping the process.
 */
export function parseProcessList(stdout: string, launchableBinary: string): RunningBundleProcess[] {
  const matches: RunningBundleProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match?.[1]) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const maybeElapsed = match[2] ?? '';
    const elapsedSeconds = parsePsDuration(maybeElapsed);
    // Without an `etime` column the second field is the head of the command
    // line, so put it back rather than swallowing it.
    const commandLine = Number.isNaN(elapsedSeconds)
      ? `${maybeElapsed} ${match[3] ?? ''}`.trim()
      : (match[3] ?? '');
    if (!commandLine.includes(launchableBinary)) continue;
    matches.push({ pid, commandLine, elapsedSeconds });
  }
  return matches;
}

/**
 * Refuses a browser-harness launch when this objdir's app is already alive,
 * or terminates the parent when the operator explicitly opted into stale
 * browser cleanup. This closes the no-listening-port variant of the stale
 * Marionette process failure.
 */
export async function ensureLaunchableBrowserNotRunning(
  launchableBinary: string,
  options: { killStaleBrowser?: boolean } = {}
): Promise<void> {
  const processes = await findRunningBundleProcesses(launchableBinary);
  if (processes.length === 0) return;

  const parent = processes.find((candidate) => !candidate.commandLine.includes('-contentproc'));
  const holder = parent ?? processes[0];
  if (!holder) return;

  if (options.killStaleBrowser) {
    try {
      if (process.platform === 'win32') {
        await exec('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Stop-Process -Id ${holder.pid} -Force`,
        ]);
      } else {
        process.kill(holder.pid, 'SIGTERM');
      }
      return;
    } catch (error: unknown) {
      throw new PreflightRefusalError(
        `A browser from this objdir is still running (PID ${holder.pid}), but FireForge could not terminate it: ${toError(error).message}`,
        'stale-browser-kill-failed'
      );
    }
  }

  throw new PreflightRefusalError(describeRunningBundleRefusal(holder), 'stale-browser');
}

/**
 * True when the process was launched by a test harness, i.e. its command
 * line carries `-marionette` (the control channel every `fireforge test`
 * browser is started with) or a harness `-profile`.
 *
 * This is the distinction the refusal turns on. The objdir-bundle probe
 * matches any process running this project's binary, which on a shared
 * checkout includes a peer session's live browser and a developer's own
 * interactive one. Only a marionette-driven browser is safely
 * attributable to an interrupted run.
 */
function isHarnessDrivenBrowser(commandLine: string): boolean {
  return /\s-marionette(?:\s|$)/.test(commandLine) || /\s-profile(?:\s|=)/.test(commandLine);
}

/**
 * Builds the refusal for a running objdir browser.
 *
 * Reports the evidence rather than a bare PID: the elapsed time and the
 * command line are what let an operator on a shared checkout decide whose
 * process it is, without reconstructing PID ancestry by hand. A downstream
 * fork hit exactly this: the message named a PID belonging to a peer
 * session's live browser and offered a flag that would have killed a
 * multi-hour evaluation run.
 *
 * So `--kill-stale-marionette` is offered only for a marionette-driven
 * browser. For a bare launch the message says what it found and stops:
 * FireForge cannot tell a dead run's orphan from someone's live window, and
 * the flag is the right manual clear once ownership is verified, never an
 * automatic one.
 *
 * Exported for direct unit testing.
 */
export function describeRunningBundleRefusal(holder: RunningBundleProcess): string {
  const killHint =
    process.platform === 'win32'
      ? `Stop-Process -Id ${holder.pid} -Force`
      : `kill ${holder.pid}  # or "kill -9 ${holder.pid}" if it doesn't exit`;
  const elapsed = formatPsDuration(holder.elapsedSeconds);
  const age = elapsed !== undefined ? ` running for ${elapsed}` : '';
  const harnessDriven = isHarnessDrivenBrowser(holder.commandLine);
  const evidence =
    `A browser from this project's objdir is already running (PID ${holder.pid}${age}).\n` +
    `  command: ${holder.commandLine}\n`;

  if (harnessDriven) {
    return (
      evidence +
      '  This one carries harness arguments (-marionette/-profile), so it is very likely an orphan ' +
      'of a timed-out or interrupted "fireforge test" run, and it can wedge the next headed launch.\n' +
      `  Stop it with "${killHint}", or retry with "--kill-stale-marionette".`
    );
  }
  return (
    evidence +
    '  This one carries NO harness arguments (-marionette/-profile), so it is not a test browser — ' +
    "it is more likely a developer's own window, or another session sharing this checkout.\n" +
    '  "--kill-stale-marionette" is deliberately NOT suggested here: FireForge cannot tell an orphan ' +
    "from someone else's live browser. Confirm the owner (start time above, and the command line), " +
    `then stop it yourself with "${killHint}" if it is in fact yours.`
  );
}

/**
 * Returns `true` when the holder's command basename or command-line
 * flags clearly identify it as a Firefox-family browser with
 * Marionette enabled. Used to decide whether to raise a targeted
 * "stale browser on port" error vs a soft "unrelated listener"
 * warning.
 *
 * Includes the operator-provided `binaryName` from `fireforge.json`
 * so a fork that ships under a custom name (e.g.
 * `mybrowser-nightly`) is still recognised as a browser.
 */
function isBrowserMarionettePortHolder(holder: MarionettePortHolder, binaryName?: string): boolean {
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
 * `{ inUse: false }` when the port is free or when `lsof` is not
 * available. The probe is a best-effort courtesy check, so a
 * missing tool must not block the test run.
 */
async function probeWithLsof(port: number): Promise<MarionettePortProbeResult> {
  try {
    // `-sTCP:LISTEN` filters to listeners only, and `-P -n` avoids
    // service/host lookups (faster + no DNS-dependent flakiness).
    // `-Fpcn` emits a machine-readable format: one field per line,
    // with `p<pid>`, `c<command>`, `n<name>` records.
    const result = await exec('lsof', ['-i', `tcp:${port}`, '-P', '-n', '-sTCP:LISTEN', '-Fpcn']);
    // `lsof` exits 1 when no matches, which means "port is free" rather
    // than an error. We key off stdout shape instead of exit code.
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
    // `lsof` does not return the full command line, but `ps` does. A
    // missing `ps` (exotic Linux container) falls back to `command`
    // alone, which is still enough to match `BROWSER_BASENAMES`.
    let commandLine = command;
    try {
      const psResult = await exec('ps', ['-p', String(pid), '-o', 'args=']);
      const psLine = psResult.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (psLine) commandLine = psLine.trim();
    } catch {
      // ps not available, so keep the basename.
    }
    return { inUse: true, holder: { pid, command, commandLine } };
  } catch {
    // `lsof` missing, or its stdout did not parse. Either way the port state
    // is unknown, and an unknown port is reported as free so the probe never
    // blocks a run on its own uncertainty. (The errno test that used to sit
    // here returned the same value as this fallthrough, so it decided
    // nothing.)
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
    // Unparseable netstat/PowerShell output. The port state is unknown, and an unknown port
    // is reported free so the probe never blocks a run on its own uncertainty.
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
  let platform: Platform;
  try {
    platform = getPlatform();
  } catch {
    // Unrecognised host platform, so no probe strategy applies and the port is
    // reported free rather than blocking the run.
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
 * is held by a browser process. Raises a softer warning-shaped
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
  if (isBrowserMarionettePortHolder(holder, options.binaryName)) {
    const killHint =
      process.platform === 'win32'
        ? `Stop-Process -Id ${holder.pid} -Force`
        : `kill ${holder.pid}  # or "kill -9 ${holder.pid}" if it doesn't exit`;
    throw new PreflightRefusalError(
      `Marionette port ${port} is already in use by ${holder.command} (PID ${holder.pid}). ` +
        `This is usually a browser left running by a previously interrupted "fireforge test" run. ` +
        `Kill it with "${killHint}", then retry. ` +
        `(If you expected ${holder.command} to be running on ${port}, stop it manually or pass ` +
        `"--marionette-port <port>" to launch mach test on a different port.)`,
      'marionette-port-busy'
    );
  }

  // Non-browser holder: mach test will still fail to bind, but the
  // cause is not a stale FireForge-launched browser. Flag it
  // explicitly so the operator can decide what to do instead of
  // getting mach's bind error with no FireForge context.
  throw new PreflightRefusalError(
    `Marionette port ${port} is already in use by ${holder.command} (PID ${holder.pid}). ` +
      `This is not a FireForge-launched browser; stop the holder process or free the port before rerunning.`,
    'marionette-port-busy'
  );
}

/**
 * Ensures the Marionette port is usable, optionally terminating a stale
 * Firefox-family browser holder first. Unrelated listeners still fail.
 */
export async function ensureMarionettePortAvailable(
  port: number = DEFAULT_MARIONETTE_PORT,
  options: { binaryName?: string; killStaleBrowser?: boolean } = {}
): Promise<void> {
  const probe = await probeMarionettePort(port);
  if (!probe.inUse || !probe.holder) return;

  const holder = probe.holder;
  const isBrowser = isBrowserMarionettePortHolder(holder, options.binaryName);
  if (!options.killStaleBrowser || !isBrowser) {
    await assertMarionettePortAvailable(port, options);
    return;
  }

  try {
    if (process.platform === 'win32') {
      await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Stop-Process -Id ${holder.pid} -Force`,
      ]);
    } else {
      process.kill(holder.pid, 'SIGTERM');
    }
  } catch (error: unknown) {
    throw new PreflightRefusalError(
      `Marionette port ${port} is held by stale browser ${holder.command} (PID ${holder.pid}), ` +
        `but FireForge could not terminate it: ${toError(error).message}`,
      'stale-browser-kill-failed'
    );
  }
}

/**
 * Extracts a `--marionette-port=N` (or `--marionette-port N`) argument from
 * a list of forwarded mach args, if present. Used so an operator passing the
 * port via `--mach-arg --marionette-port=NNNN` gets the same preflight
 * override they would from a first-class `--marionette-port` option, rather
 * than the wrapper probing the default port and refusing.
 *
 * Also recognises `--setpref=marionette.port=NNNN` since that is the path
 * the test command auto-forwards to mach.
 *
 * @param machArgs - Forwarded mach args as they would appear on the command
 *   line (one element per token, with `--foo=bar` and `--foo bar` both
 *   supported).
 * @returns The integer port if a recognised arg is present and parses,
 *   otherwise `undefined`.
 */
export function extractForwardedMarionettePort(machArgs: string[]): number | undefined {
  for (const [i, arg] of machArgs.entries()) {
    // `--marionette-port=NNNN`
    let match = /^--marionette-port=(\d+)$/.exec(arg);
    if (match?.[1]) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n)) return n;
    }
    // `--marionette-port NNNN` (two tokens)
    if (arg === '--marionette-port') {
      const next = machArgs[i + 1];
      if (next !== undefined) {
        const n = Number.parseInt(next, 10);
        if (Number.isFinite(n)) return n;
      }
    }
    // `--setpref=marionette.port=NNNN`, the auto-forward shape. Recognised
    // here so a duplicate check at the call site can spot operator-supplied
    // setprefs without re-implementing the parse.
    match = /^--setpref=marionette\.port=(\d+)$/.exec(arg);
    if (match?.[1]) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * True when forwarded mach args already set a Marionette **client** address
 * for mach/mochitest (`--marionette=host:port` or `--marionette host:port`).
 * Used only to avoid duplicating FireForge's auto-injected
 * `--marionette=127.0.0.1:<n>`. This is not a full URL validator (IPv6,
 * etc.).
 *
 * Does not treat `--marionette-port` as a client endpoint.
 */
export function forwardedMachArgsIncludeMarionetteClient(machArgs: string[]): boolean {
  const valueLooksLikeHostPort = (token: string): boolean =>
    /:[0-9]+$/.test(token) || /^\[[^]]+\]:[0-9]+$/.test(token);

  for (const [i, arg] of machArgs.entries()) {
    if (arg.startsWith('--marionette=') && !arg.startsWith('--marionette-port=')) {
      return true;
    }
    if (arg === '--marionette') {
      const next = machArgs[i + 1];
      if (next !== undefined && valueLooksLikeHostPort(next)) return true;
    }
  }
  return false;
}

/**
 * True when forwarded mach args explicitly select the xpcshell harness.
 * Used so `--marionette-port` auto-forward skips `--setpref=marionette.port`
 * for runs where the pref is ignored anyway.
 */
export function hasExplicitXpcshellFlavor(machArgs: string[]): boolean {
  for (const [i, arg] of machArgs.entries()) {
    if (/^--flavor=xpcshell\b/.test(arg) || arg === '--flavor=xpcshell-tests') return true;
    if (arg === '--flavor' && /^xpcshell(?:-tests)?$/.test(machArgs[i + 1] ?? '')) return true;
  }
  return false;
}

/**
 * Whether `fireforge test` should append `--setpref=marionette.port=<n>` and
 * `--marionette=127.0.0.1:<n>` when the operator passed `--marionette-port`.
 * Forwards for every harness except an explicit `--flavor=xpcshell` /
 * `xpcshell-tests` (toolkit widget mochitests under `toolkit/content/tests/`
 * do not match the older path-only heuristic but still launch a
 * Marionette-driven browser).
 */
export function shouldAutoForwardMarionettePortToMach(machArgs: string[]): boolean {
  return !hasExplicitXpcshellFlavor(machArgs);
}
