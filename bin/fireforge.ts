#!/usr/bin/env node
// SPDX-License-Identifier: EUPL-1.2
/**
 * FireForge CLI entry point.
 *
 * This is the only file that should call process.exit().
 * All shared library code propagates errors via CommandError or
 * FireForgeError — never by terminating the process directly.
 *
 * The signal pipeline below composes several lifecycle modules; the
 * invariants it upholds (and who owns what) are documented in
 * docs/lifecycle-invariants.md, and the composed behavior is pinned by
 * src/core/__tests__/signal-compound-mutation-scenario.test.ts.
 */

import { installBrokenPipeHandler, main } from '../src/cli.js';
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
 * SIGKILL escalation can actually complete — exiting earlier is what used
 * to orphan hung Firefox trees. A second Ctrl+C escalates to SIGKILL
 * immediately, so an impatient operator is never stuck waiting.
 */
const CHILD_SHUTDOWN_TIMEOUT_MS = 12_000;

/**
 * Upper bound (ms) a delayed exit waits for stdout/stderr to drain. When
 * stdout is a pipe it is ASYNC, and `process.exit()` discards anything
 * queued past the 64 KiB kernel buffer — which truncated the
 * `status --json --fail-on` refusal payload for every piped consumer.
 * Bounded so a stalled reader can never wedge a failing process; an
 * EPIPE'd/closed pipe releases the wait immediately.
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
    // Run furnace rollback, signal-critical-section drain, and child
    // shutdown in parallel. Rebase-style operations register critical
    // sections (apply + session persist) via `runInSignalCriticalSection`;
    // awaiting them here ensures the CLI never exits with a patch applied
    // to the engine but a stale session file that would mis-track progress
    // on `--continue`. Waiting on child shutdown keeps the parent alive
    // through the SIGTERM → grace → SIGKILL escalation that
    // execInherit/execSmokeRun forward to Firefox/mach — exiting before it
    // ran is what used to orphan hung child trees.
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
      // Force-release the furnace lock directory after rollback completes.
      // `withFileLock`'s `finally { rm }` never runs when we `process.exit`
      // the handler below, so without this sweep the lock survives the
      // process and wedges the next `fireforge furnace …` / `fireforge
      // test --build` command until the staleness window elapses. See
      // `forceReleaseFurnaceLocksForActiveOperations` for why the sweep is
      // best-effort (errors are logged, not thrown).
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
