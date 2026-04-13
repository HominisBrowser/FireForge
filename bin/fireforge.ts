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
  isSignalRollbackInFlight,
  rollbackActiveOperationsForSignal,
} from '../src/core/furnace-operation.js';
import { CommandError } from '../src/errors/base.js';

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
    rollbackActiveOperationsForSignal(signal)
      .catch((error: unknown) => {
        console.error(
          `Furnace rollback after ${signal} failed:`,
          error instanceof Error ? error.message : error
        );
      })
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
