#!/usr/bin/env node
// SPDX-License-Identifier: EUPL-1.2
/**
 * FireForge CLI entry point.
 *
 * This is the only file that should call process.exit().
 * All shared library code propagates errors via CommandError or
 * FireForgeError — never by terminating the process directly.
 *
 */

import { installBrokenPipeHandler, main } from '../src/cli.js';
import {
  forceReleaseFurnaceLocksForActiveOperations,
  isSignalRollbackInFlight,
  rollbackActiveOperationsForSignal,
} from '../src/core/furnace-operation.js';
import { waitForActiveCriticalSections } from '../src/core/signal-critical.js';
import { CommandError } from '../src/errors/base.js';

/**
 * Upper bound (ms) the signal handler will wait for any in-flight critical
 * section (e.g. rebase apply + session persist) to finish before calling
 * process.exit. Keep short so a stuck I/O operation cannot indefinitely
 * postpone the exit a user requested with Ctrl+C.
 */
const SIGNAL_CRITICAL_SECTION_TIMEOUT_MS = 5_000;

installBrokenPipeHandler();

process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    'Fatal error (unhandled rejection):',
    reason instanceof Error ? reason.message : reason
  );
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
  process.exit(1);
});

// SIGINT / SIGTERM handlers run any in-flight furnace rollback before
// terminating. The library cannot call process.exit itself (the
// process-boundary test enforces that invariant), so the bin entry point owns
// both the rollback dispatch and the exit. The handler is a no-op when no
// furnace mutation is currently registered with the lifecycle wrapper, so
// patch-only commands behave exactly as before.
function installFurnaceSignalHandler(signal: 'SIGINT' | 'SIGTERM', exitCode: number): void {
  process.on(signal, () => {
    if (isSignalRollbackInFlight()) {
      // A second Ctrl+C while we're already rolling back is a noisy "I want
      // out now" — let the second signal terminate the process forcefully
      // rather than queueing another rollback that will race the first.
      process.exit(exitCode);
    }
    // Run furnace rollback and signal-critical-section drain in parallel.
    // Rebase-style operations register critical sections (apply + session
    // persist) via `runInSignalCriticalSection`; awaiting them here ensures
    // the CLI never exits with a patch applied to the engine but a stale
    // session file that would mis-track progress on `--continue`.
    void Promise.allSettled([
      rollbackActiveOperationsForSignal(signal).catch((error: unknown) => {
        console.error(
          `Furnace rollback after ${signal} failed:`,
          error instanceof Error ? error.message : error
        );
      }),
      waitForActiveCriticalSections(SIGNAL_CRITICAL_SECTION_TIMEOUT_MS),
    ])
      // Force-release the furnace lock directory after rollback completes.
      // `withFileLock`'s `finally { rm }` never runs when we `process.exit`
      // the handler below, so without this sweep the lock survives the
      // process and wedges the next `fireforge furnace …` / `fireforge
      // test --build` command until the staleness window elapses. See
      // `forceReleaseFurnaceLocksForActiveOperations` for why the sweep is
      // best-effort (errors are logged, not thrown).
      .then(() => forceReleaseFurnaceLocksForActiveOperations())
      .finally(() => {
        process.exit(exitCode);
      });
  });
}

installFurnaceSignalHandler('SIGINT', 130);
installFurnaceSignalHandler('SIGTERM', 143);

main().catch((error: unknown) => {
  if (error instanceof CommandError) {
    process.exit(error.exitCode);
  }

  // Truly unexpected — CommandError should have been thrown by withErrorHandling
  console.error('Fatal error:', error);
  process.exit(1);
});
