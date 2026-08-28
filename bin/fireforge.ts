#!/usr/bin/env node
// SPDX-License-Identifier: EUPL-1.2
/**
 * FireForge CLI entry point, and the only file that may call process.exit().
 * Library code propagates errors via CommandError or FireForgeError instead.
 *
 * The signal pipeline below composes several lifecycle modules; see
 * docs/lifecycle-invariants.md for who owns what.
 */

import { installBrokenPipeHandler, main } from '../src/cli.js';
import { emitKilledVerdict } from '../src/commands/test-verdict.js';
import { forceReleaseHeldLocksForSignal } from '../src/core/file-lock.js';
import {
  forceReleaseFurnaceLocksForActiveOperations,
  isSignalRollbackInFlight,
  rollbackActiveOperationsForSignal,
} from '../src/core/furnace-operation.js';
import { waitForActiveCriticalSections } from '../src/core/signal-critical.js';
import { CommandError } from '../src/errors/base.js';
import { waitForActiveChildShutdown } from '../src/utils/process.js';
import { waitForStdioDrain } from '../src/utils/stdio-drain.js';

/**
 * Upper bound (ms) the signal handler will wait for any in-flight critical
 * section (e.g. rebase apply + session persist) to finish before calling
 * process.exit. Keep short so a stuck I/O operation cannot indefinitely
 * postpone the exit a user requested with Ctrl+C.
 */
const SIGNAL_CRITICAL_SECTION_TIMEOUT_MS = 5_000;

/**
 * Upper bound (ms) the signal handler waits for spawned children (Firefox
 * under `run`/`test`, mach under `build`) to shut down after the signal was
 * forwarded to them. Must exceed the largest child grace window
 * (execSmokeRun's killGraceMs default of 10 s) so the SIGTERM → grace →
 * SIGKILL escalation can complete; exiting earlier orphans hung Firefox
 * trees. A second Ctrl+C escalates to SIGKILL immediately.
 */
const CHILD_SHUTDOWN_TIMEOUT_MS = 12_000;

/**
 * Upper bound (ms) a delayed exit waits for stdout/stderr to drain. A pipe
 * is ASYNC, so `process.exit()` discards anything queued past the 64 KiB
 * kernel buffer — enough to truncate a JSON payload mid-object. Bounded so
 * a stalled reader cannot wedge a failing process; an EPIPE'd/closed pipe
 * releases the wait immediately.
 */
const STDIO_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Drains stdio, then exits. Every delayed exit routes through here — only
 * the second-Ctrl+C force-exit (an explicit "out NOW") and this helper's
 * own call terminate directly.
 */
function exitAfterStdioFlush(code: number): void {
  void waitForStdioDrain(STDIO_FLUSH_TIMEOUT_MS).finally(() => {
    process.exit(code);
  });
}

installBrokenPipeHandler();

process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    'Fatal error (unhandled rejection):',
    reason instanceof Error ? reason.message : reason
  );
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
  exitAfterStdioFlush(1);
});

// SIGINT / SIGTERM run any in-flight furnace rollback before terminating.
// The library may not call process.exit itself, so the entry point owns both
// the rollback dispatch and the exit. A no-op when no furnace mutation is
// registered with the lifecycle wrapper.
function installFurnaceSignalHandler(signal: 'SIGINT' | 'SIGTERM', exitCode: number): void {
  process.on(signal, () => {
    // First, before anything that can stall: a killed test run must leave a
    // terminal line, or a log tail cannot tell "killed" from "still
    // running" from "never started". The drain below is bounded but not
    // instant, and the verdict must survive a drain that times out.
    // No-op unless a test run was actually in flight.
    try {
      emitKilledVerdict(signal);
    } catch {
      // A diagnostic must never keep the process from exiting.
    }
    if (isSignalRollbackInFlight()) {
      // A second Ctrl+C while we're already rolling back is a noisy "I want
      // out now" — let the second signal terminate the process forcefully
      // rather than queueing another rollback that will race the first.
      process.exit(exitCode);
    }
    // Rollback, critical-section drain, and child shutdown run in parallel.
    // Draining critical sections (rebase's apply + session persist, registered
    // via `runInSignalCriticalSection`) keeps the CLI from exiting with a patch
    // applied to the engine but a stale session file that mis-tracks progress
    // on `--continue`. Waiting on child shutdown keeps the parent alive through
    // the SIGTERM → grace → SIGKILL escalation execInherit/execSmokeRun forward
    // to Firefox/mach; exiting first orphans those trees.
    void Promise.allSettled([
      rollbackActiveOperationsForSignal(signal).catch((error: unknown) => {
        console.error(
          `Furnace rollback after ${signal} failed:`,
          error instanceof Error ? error.message : error
        );
      }),
      waitForActiveCriticalSections(SIGNAL_CRITICAL_SECTION_TIMEOUT_MS),
      waitForActiveChildShutdown(CHILD_SHUTDOWN_TIMEOUT_MS),
    ])
      // `withFileLock`'s `finally { rm }` never runs across `process.exit`,
      // so both sweeps exist for the same reason. The generic one covers
      // every lock this process holds (engine session, patch directory,
      // build); the furnace one stays because it carries rollback
      // bookkeeping the generic sweep does not, and runs after it so the
      // ownership checks see a settled tree.
      .then(() => forceReleaseHeldLocksForSignal())
      .then(() => forceReleaseFurnaceLocksForActiveOperations())
      .finally(() => {
        exitAfterStdioFlush(exitCode);
      });
  });
}

installFurnaceSignalHandler('SIGINT', 130);
installFurnaceSignalHandler('SIGTERM', 143);

main().catch((error: unknown) => {
  if (error instanceof CommandError) {
    exitAfterStdioFlush(error.exitCode);
    return;
  }

  // Truly unexpected — CommandError should have been thrown by withErrorHandling
  console.error('Fatal error:', error);
  exitAfterStdioFlush(1);
});
