// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge test --auto-ports` (or `test.mochitestPorts: "auto"`): let two
 * checkouts run browser suites at the same time.
 *
 * Desktop `mach mochitest` has no `--http-port`/`--ssl-port` options; those
 * exist only in the Android and iOS argument sets. What recent engines do
 * have is a fallback inside `testing/mochitest/runtests.py`: before starting
 * its servers the harness bind-probes the HTTP server, ssltunnel and
 * WebSocket ports, and before launching the browser the Marionette port,
 * and moves any that is busy to a free port, routing `mochi.test:8888`
 * through its proxy to wherever the server actually landed. FireForge's
 * own preflight refused before that fallback could run. In auto mode it
 * steps aside for a holder that is not this checkout's own (a sibling
 * checkout's live suite, or an unrelated listener), and keeps refusing for
 * this checkout's own leftovers, exactly as in the default mode.
 *
 * Auto mode is opt-in, and it only takes effect when the engine's harness
 * is seen to carry the fallback: on an engine without it, a busy port would
 * still collide, so the default refusal stays in force there.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { notice } from '../utils/logger.js';
import { isExplicitAbsolutePath, isPathInsideRoot } from '../utils/paths.js';
import { type MarionettePortHolder, probeMarionettePort } from './marionette-port.js';

/** Which busy-port fallbacks the engine's mochitest harness carries. */
export interface HarnessPortFallback {
  /** HTTP server, ssltunnel and WebSocket ports (`startServers`). */
  serverPorts: boolean;
  /** The Marionette port (before the browser launch). */
  marionettePort: boolean;
}

const RUNTESTS_PATH = 'testing/mochitest/runtests.py';

/**
 * Reads the engine's `runtests.py` for the busy-port fallbacks. An
 * unreadable file reports neither, which keeps the default refusal.
 */
export async function detectHarnessPortFallback(engineDir: string): Promise<HarnessPortFallback> {
  let source: string;
  try {
    source = await readFile(join(engineDir, RUNTESTS_PATH), 'utf8');
  } catch {
    return { serverPorts: false, marionettePort: false };
  }
  const fallsBack = /falling back to port/.test(source);
  return {
    serverPorts: fallsBack && /\("httpPort",/.test(source) && /_port_in_use\(port\)/.test(source),
    marionettePort: fallsBack && /_port_in_use\(marionette_port\)/.test(source),
  };
}

/** True when the operator asked for auto ports, by flag or by config. */
export function autoPortsRequested(options: TestOptions, config: FireForgeConfig): boolean {
  return options.autoPorts === true || config.test?.mochitestPorts === 'auto';
}

/**
 * True when the holder's command line points into THIS checkout's engine
 * directory: our own leftover, which auto mode never steps aside for.
 */
export function isThisCheckoutsHolder(holder: MarionettePortHolder, engineDir: string): boolean {
  return holder.commandLine
    .split(/\s+/)
    .filter(isExplicitAbsolutePath)
    .some((token) => isPathInsideRoot(engineDir, token));
}

/**
 * Resolves the effective auto-ports posture for a browser run: what the
 * engine's harness can fall back from, or `undefined` when auto mode is
 * off or the engine cannot honour it (in which case the default refusal
 * stays, and an explicit request says why).
 */
export async function resolveAutoPorts(
  engineDir: string,
  options: TestOptions,
  config: FireForgeConfig
): Promise<HarnessPortFallback | undefined> {
  if (!autoPortsRequested(options, config)) return undefined;
  const fallback = await detectHarnessPortFallback(engineDir);
  if (!fallback.serverPorts && !fallback.marionettePort) {
    notice(
      `Auto ports requested, but engine/${RUNTESTS_PATH} has no busy-port fallback, so a busy ` +
        'mochitest or Marionette port is still refused as in the default mode.'
    );
    return undefined;
  }
  return fallback;
}

/**
 * Steps aside for a busy port the harness will fall back from. Returns true
 * (after a notice naming the holder) when the port is held by anything that
 * is not this checkout's own process, false when the port is free or the
 * holder is ours, so the caller's normal preflight runs.
 *
 * @param port - The default port the harness would use
 * @param label - Human name of the port for the notice
 * @param engineDir - This checkout's engine directory
 */
export async function deferBusyPortToHarness(
  port: number,
  label: string,
  engineDir: string
): Promise<boolean> {
  const probe = await probeMarionettePort(port);
  if (!probe.inUse || !probe.holder) return false;
  if (isThisCheckoutsHolder(probe.holder, engineDir)) return false;
  notice(
    `${label} port ${port} is held by ${probe.holder.command} (PID ${probe.holder.pid}), which is ` +
      "not this checkout's. Auto ports: the harness moves this run to a free port instead."
  );
  return true;
}
