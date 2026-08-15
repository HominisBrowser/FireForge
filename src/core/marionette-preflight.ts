// SPDX-License-Identifier: EUPL-1.2
/**
 * Marionette handshake preflight for `fireforge test --doctor`.
 *
 * Answers a single question before tests run: "does marionette come up?" A
 * silent 360-second mach-test hang is indistinguishable from "tests failed
 * to discover"; this helper surfaces the failure in under a minute with a
 * clear PASS/FAIL line and the tail of the browser's stderr.
 *
 * The probe is a cascade of layered checks (engine → mach → python →
 * profile → spawn → handshake). Each layer has a tight per-attempt budget
 * so a broken earlier layer fails fast with a specific diagnosis rather
 * than blocking on the final socket poll for the full overall budget.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';
import { ensureMach } from './mach.js';
import { getPython } from './mach-python.js';

/** Marionette's default TCP port when the browser is launched with `--marionette`. */
const MARIONETTE_PORT = 2828;

/** Overall budget for the preflight (browser boot + socket handshake). */
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;

/** Per-attempt socket connect timeout. Polling continues until the overall budget expires. */
const SOCKET_ATTEMPT_TIMEOUT_MS = 2_000;

/**
 * Grace window after spawn() returns before we accept the child as
 * "spawned OK". A browser binary that exits immediately (missing dylib,
 * wrong CPU arch, corrupt profile) must be caught here — not 30 seconds
 * later at the socket layer.
 */
const SPAWN_SETTLE_MS = 750;

/** Tail of stderr preserved for FAIL diagnostics. */
const STDERR_TAIL_LIMIT = 8 * 1024;

/**
 * Layer names, ordered by the probe sequence. Surfaced in `detail` so the
 * operator sees which layer failed without having to guess.
 */
const LAYER_NAMES = [
  'engine-present',
  'mach-available',
  'python-available',
  'profile-creatable',
  'browser-spawns',
  'marionette-handshake',
] as const;

type LayerName = (typeof LAYER_NAMES)[number];

function layerTag(name: LayerName): string {
  const index = LAYER_NAMES.indexOf(name) + 1;
  return `[layer ${index}/${LAYER_NAMES.length}: ${name}]`;
}

export interface MarionettePreflightResult {
  ok: boolean;
  durationMs: number;
  /** Human-readable summary. On FAIL, prefixed with `[layer N/6: <name>]`. */
  detail: string;
}

export interface MarionettePreflightOptions {
  /** Total budget in ms. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Overrides marionette TCP port — primarily used in tests. */
  port?: number;
  /**
   * Grace window after spawn() before the browser is considered "running
   * OK." Catches immediate crashes (missing dylib, wrong CPU arch, corrupt
   * profile) at the spawn layer rather than the handshake layer. Default:
   * {@link SPAWN_SETTLE_MS}. Tests may set this to 0 to skip the settle.
   */
  spawnSettleMs?: number;
  /** Test seam: spawn and socket connect factories. */
  spawner?: typeof spawn;
  connect?: typeof net.createConnection;
}

/**
 * Runs the marionette preflight. Returns PASS on first byte read from the
 * marionette socket within the budget; FAIL otherwise, with a diagnostic
 * identifying which layer of the cascade broke. Always tears down the
 * spawned browser before returning.
 */
export async function runMarionettePreflight(
  engineDir: string,
  options: MarionettePreflightOptions = {}
): Promise<MarionettePreflightResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const spawnSettleMs = options.spawnSettleMs ?? SPAWN_SETTLE_MS;
  const port = options.port ?? MARIONETTE_PORT;
  const spawnerFn = options.spawner ?? spawn;
  const connectFn = options.connect ?? net.createConnection;

  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  // Layer 1: engine directory exists.
  if (!(await pathExists(engineDir))) {
    return fail(
      'engine-present',
      'Engine directory not found — run "fireforge download" first.',
      elapsed()
    );
  }

  // Layer 2: mach binary resolves in the engine.
  try {
    await ensureMach(engineDir);
  } catch (error: unknown) {
    return fail(
      'mach-available',
      `mach not available in engine: ${toError(error).message}`,
      elapsed()
    );
  }

  // Layer 3: Python that mach requires is discoverable.
  let python: string;
  try {
    python = await getPython(engineDir);
  } catch (error: unknown) {
    return fail(
      'python-available',
      `Python interpreter required by mach is not available: ${toError(error).message}`,
      elapsed()
    );
  }

  // Layer 4: throwaway browser profile directory is creatable.
  let profileDir: string;
  try {
    profileDir = await mkdtemp(join(tmpdir(), 'fireforge-marionette-'));
  } catch (error: unknown) {
    return fail(
      'profile-creatable',
      `Could not create a throwaway browser profile in ${tmpdir()}: ${toError(error).message}`,
      elapsed()
    );
  }

  let child: ChildProcess | undefined;
  let stderrTail = '';

  try {
    // Layer 5: browser spawns and does not crash within the settle window.
    try {
      child = spawnerFn(
        python,
        [
          join(engineDir, 'mach'),
          'run',
          '--marionette',
          '--headless',
          '--no-remote',
          '-profile',
          profileDir,
        ],
        {
          cwd: engineDir,
          env: { ...process.env, MOZ_HEADLESS: '1' },
          stdio: ['ignore', 'ignore', 'pipe'],
          // `detached: true` puts the child in a new process group so we can
          // signal it and every descendant (Firefox, its helpers) via
          // `process.kill(-pid, …)` in the finally block. Without this, the
          // child is Python running mach; a SIGTERM kills Python but the
          // Firefox grandchild inherits the stderr pipe FD and keeps Node's
          // event loop alive even after the preflight PASS log. The symptom
          // is `fireforge test --doctor` printing `Marionette preflight:
          // PASS` and then hanging indefinitely in `uv__io_poll` — see the
          // eval finding.
          detached: true,
        }
      );
    } catch (error: unknown) {
      return fail(
        'browser-spawns',
        `Could not spawn mach run: ${toError(error).message}`,
        elapsed()
      );
    }

    const spawnedChild = child;

    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    // Short settle window — catches "binary exits immediately" failures
    // (missing dylib, wrong CPU arch, corrupt profile) before the socket
    // poll swallows the full overall budget waiting for bytes that will
    // never come.
    const settleDeadline = Math.min(spawnSettleMs, Math.max(0, timeoutMs - elapsed()));
    if (settleDeadline > 0) {
      await delay(settleDeadline);
    }
    if (hasChildExited(spawnedChild)) {
      return fail(
        'browser-spawns',
        `Browser process exited during spawn (exit code ${String(spawnedChild.exitCode)}, signal ${spawnedChild.signalCode ?? 'none'}). ` +
          `stderr tail: ${stderrTail.trim().slice(-2_000) || '(empty)'}`,
        elapsed()
      );
    }

    // Layer 6: marionette handshake within the remaining budget.
    const socketResult = await waitForMarionetteSocket(port, connectFn, () => {
      return elapsed() < timeoutMs && !hasChildExited(spawnedChild);
    });

    if (socketResult.ok) {
      return {
        ok: true,
        durationMs: elapsed(),
        detail: `Marionette handshake received on 127.0.0.1:${port} in ${Date.now() - startedAt}ms.`,
      };
    }

    // Child may have exited before the socket was ever ready — surface that
    // distinctly from "socket never answered" so the operator has a lead.
    if (hasChildExited(spawnedChild)) {
      return fail(
        'marionette-handshake',
        `Browser process exited before marionette handshake (exit code ${String(spawnedChild.exitCode)}, signal ${spawnedChild.signalCode ?? 'none'}). ` +
          `stderr tail: ${stderrTail.trim().slice(-2_000) || '(empty)'}`,
        elapsed()
      );
    }

    return fail(
      'marionette-handshake',
      `Marionette socket on 127.0.0.1:${port} did not respond within ${timeoutMs}ms. ` +
        `stderr tail: ${stderrTail.trim().slice(-2_000) || '(empty)'}`,
      elapsed()
    );
  } finally {
    if (child && !hasChildExited(child)) {
      killProcessGroup(child, 'SIGTERM');
      // Small escalation: if the child doesn't honour SIGTERM quickly, SIGKILL
      // so we don't leave a ghost mach process around after a failed probe.
      await delay(500);
      if (!hasChildExited(child)) {
        killProcessGroup(child, 'SIGKILL');
      }
    }
    // Destroy the stderr pipe explicitly. Firefox (a grandchild of the Python
    // mach wrapper we spawned) can inherit and hold the stderr FD even after
    // its direct parent exits — until the pipe closes, Node's readable
    // stream stays attached and `uv__io_poll` keeps the event loop alive.
    // `destroy()` closes the local end regardless, so `fireforge test
    // --doctor` exits cleanly after a passing preflight.
    child?.stderr?.destroy();
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch (error: unknown) {
      warn(`Could not clean up marionette preflight profile: ${toError(error).message}`);
    }
  }
}

/**
 * Sends `signal` to the child's whole process group when possible, falling
 * back to a direct `child.kill` for environments that don't support
 * `detached: true` (Windows in particular: Node still returns a pid, but
 * `kill(-pid, …)` is not a supported kernel primitive).
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH / EPERM — fall through to the narrow kill below so we at
      // least signal the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited — nothing to do.
  }
}

function fail(layer: LayerName, message: string, durationMs: number): MarionettePreflightResult {
  return {
    ok: false,
    durationMs,
    detail: `${layerTag(layer)} ${message}`,
  };
}

/** Returns true when the child process has exited (normal or signaled). */
function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForMarionetteSocket(
  port: number,
  connectFn: typeof net.createConnection,
  keepTrying: () => boolean
): Promise<{ ok: boolean }> {
  while (keepTrying()) {
    const result = await attemptMarionetteConnect(port, connectFn);
    if (result.ok) {
      return { ok: true };
    }
    await delay(400);
  }
  return { ok: false };
}

function attemptMarionetteConnect(
  port: number,
  connectFn: typeof net.createConnection
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const socket = connectFn({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Ignore — already closed.
      }
      resolve({ ok });
    };

    const attemptTimer = setTimeout(() => {
      finish(false);
    }, SOCKET_ATTEMPT_TIMEOUT_MS);
    attemptTimer.unref();

    socket.once('connect', () => {
      // Connect alone is insufficient — the marionette server performs a
      // handshake send as soon as the socket opens, so wait for at least one
      // byte to confirm the server is actually speaking marionette.
      const readTimer = setTimeout(() => {
        finish(false);
      }, SOCKET_ATTEMPT_TIMEOUT_MS);
      readTimer.unref();
      socket.once('data', () => {
        clearTimeout(readTimer);
        finish(true);
      });
    });

    socket.once('error', () => {
      finish(false);
    });
    socket.once('close', () => {
      finish(false);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** Renders a PASS/FAIL banner to the CLI using the shared logger helpers. */
export function reportMarionettePreflight(result: MarionettePreflightResult): void {
  if (result.ok) {
    info(`Marionette preflight: PASS (${result.durationMs}ms) — ${result.detail}`);
  } else {
    warn(`Marionette preflight: FAIL (${result.durationMs}ms) — ${result.detail}`);
  }
}

/**
 * Formats the PASS/FAIL banner as a plain string for direct
 * `process.stdout.write` use — bypasses the clack logger entirely so
 * operators running `fireforge test --doctor` under a non-TTY (pipe,
 * CI, `tee`-wrapped capture) always see the final line even when the
 * clack renderer swallows trailing log output just before process exit.
 *
 * 2026-04-24 eval Finding 7 reproducibly captured only the `"Running
 * marionette preflight..."` intro and no PASS line at all — the
 * `success()` + `outro()` + direct `stdout.write` belt-and-suspenders
 * we used to ship still lost the summary under some non-TTY flush
 * races. Returning the raw string here lets the caller compose a single
 * authoritative write without any clack layer between the probe and
 * the captured log.
 */
export function formatMarionettePreflightLine(result: MarionettePreflightResult): string {
  const status = result.ok ? 'PASS' : 'FAIL';
  return `Marionette preflight: ${status} (${result.durationMs}ms) — ${result.detail}`;
}
