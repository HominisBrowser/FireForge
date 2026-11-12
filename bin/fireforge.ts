#!/usr/bin/env node
// SPDX-License-Identifier: EUPL-1.2
/**
 * The process entry, and the only file that ends the process. Everything
 * else returns an exit code or throws.
 */
import { runProgram } from '../src/cli/program.js';
import { drainStdio, handleBrokenPipe } from '../src/cli/stdio.js';
import { program } from '../src/commands/index.js';
import { installSignalHandlers, isShuttingDown } from '../src/kernel/signals.js';
import { isInteractive } from '../src/kernel/tty.js';

/**
 * Upper bound on the wait for stdout and stderr before a delayed exit.
 * `process.exit` discards what a pipe still has queued, so every exit but the
 * forced one drains first; the bound keeps a stalled reader from wedging it.
 */
const STDIO_FLUSH_TIMEOUT_MS = 5_000;

function exitAfterFlush(code: number): void {
  void drainStdio(STDIO_FLUSH_TIMEOUT_MS).finally(() => {
    process.exit(code);
  });
}

handleBrokenPipe();

process.on('unhandledRejection', (reason: unknown) => {
  console.error('Fatal error (unhandled rejection):', reason);
  exitAfterFlush(1);
});

// The first SIGINT, SIGTERM or SIGHUP runs the interrupt pipeline (stop children, roll
// back, release locks) and then exits. A second one exits immediately.
installSignalHandlers({
  exit: exitAfterFlush,
  forceExit: (code) => process.exit(code),
});

runProgram(program, {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  interactive: isInteractive(),
}).then(
  (code) => {
    // An interrupted command also ends, usually with an error. The interrupt
    // pipeline is still undoing and releasing, and the exit is its to make.
    if (!isShuttingDown()) exitAfterFlush(code);
  },
  (error: unknown) => {
    console.error('Fatal error:', error);
    exitAfterFlush(1);
  }
);
