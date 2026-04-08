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

main().catch((error: unknown) => {
  if (error instanceof CommandError) {
    process.exit(error.exitCode);
  }

  // Truly unexpected — CommandError should have been thrown by withErrorHandling
  console.error('Fatal error:', error);
  process.exit(1);
});
