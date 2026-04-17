// SPDX-License-Identifier: EUPL-1.2
/**
 * Marionette handshake preflight for `fireforge test --doctor`.
 *
 * Answers a single question before tests run: "does marionette come up?" A
 * silent 360-second mach-test hang is indistinguishable from "tests failed
 * to discover"; this helper surfaces the failure in under a minute with a
 * clear PASS/FAIL line and the tail of the browser's stderr.
 *
 * The probe is intentionally narrow — it does not replace mach test or try
 * to execute anything via marionette. It spawns `mach run --marionette
 * --headless` (plus a throwaway profile) and waits for the marionette server
 * to accept a TCP connection on the conventional port. Any byte read from
 * the socket proves a handshake payload is being produced.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Tail of stderr preserved for FAIL diagnostics. */
const STDERR_TAIL_LIMIT = 8 * 1024;

export interface MarionettePreflightResult {
  ok: boolean;
  durationMs: number;
  /** Human-readable summary. */
  detail: string;
}

export interface MarionettePreflightOptions {
  /** Total budget in ms. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Overrides marionette TCP port — primarily used in tests. */
  port?: number;
  /** Test seam: spawn and socket connect factories. */
  spawner?: typeof spawn;
  connect?: typeof net.createConnection;
}

/**
 * Runs the marionette preflight. Returns PASS on first byte read from the
 * marionette socket within the budget; FAIL otherwise. Always tears down the
 * spawned browser before returning.
 */
export async function runMarionettePreflight(
  engineDir: string,
  options: MarionettePreflightOptions = {}
): Promise<MarionettePreflightResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const port = options.port ?? MARIONETTE_PORT;
  const spawnerFn = options.spawner ?? spawn;
  const connectFn = options.connect ?? net.createConnection;

  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  if (!(await pathExists(engineDir))) {
    return {
      ok: false,
      durationMs: elapsed(),
      detail: 'Engine directory not found — run "fireforge download" first.',
    };
  }

  try {
    await ensureMach(engineDir);
  } catch (error: unknown) {
    return {
      ok: false,
      durationMs: elapsed(),
      detail: `mach not available in engine: ${(error as Error).message}`,
    };
  }

  const python = await getPython(engineDir);
  const profileDir = await mkdtemp(join(tmpdir(), 'fireforge-marionette-'));

  let child: ChildProcess | undefined;
  let stderrTail = '';

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
      }
    );

    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    const spawnedChild = child;
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
      return {
        ok: false,
        durationMs: elapsed(),
        detail:
          `Browser process exited before marionette handshake (exit code ${String(spawnedChild.exitCode)}, signal ${spawnedChild.signalCode ?? 'none'}). ` +
          `stderr tail: ${stderrTail.trim().slice(-2_000) || '(empty)'}`,
      };
    }

    return {
      ok: false,
      durationMs: elapsed(),
      detail:
        `Marionette socket on 127.0.0.1:${port} did not respond within ${timeoutMs}ms. ` +
        `stderr tail: ${stderrTail.trim().slice(-2_000) || '(empty)'}`,
    };
  } finally {
    if (child && !hasChildExited(child)) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited — nothing to do.
      }
      // Small escalation: if the child doesn't honour SIGTERM quickly, SIGKILL
      // so we don't leave a ghost mach process around after a failed probe.
      await delay(500);
      if (!hasChildExited(child)) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch (error: unknown) {
      warn(`Could not clean up marionette preflight profile: ${(error as Error).message}`);
    }
  }
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
