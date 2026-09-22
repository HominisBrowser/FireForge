// SPDX-License-Identifier: EUPL-1.2
/**
 * Stdin-fed command execution with byte-exact stdout.
 *
 * Its own module rather than a function in `process.ts` only because that
 * file sits on a 500-line budget. The logic belongs to the exec layer.
 */
import { spawn } from 'node:child_process';

import { buildChildEnv } from './child-env.js';
import { exitCodeFromClose } from './process.js';

/** Options for {@link execWithInput}. */
export interface ExecWithInputOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables merged over `process.env` */
  env?: Record<string, string>;
}

/** Result of {@link execWithInput}: stdout stays raw bytes. */
export interface ExecBufferResult {
  /** Standard output, uncapped and undecoded */
  stdout: Buffer;
  /** Standard error, decoded as UTF-8 */
  stderr: string;
  /** Process exit code */
  exitCode: number;
}

/**
 * Runs a command, writes `input` to its stdin, and returns stdout as raw
 * bytes. For batch protocols (`git cat-file --batch`) whose framing counts
 * bytes: the decoded, 50 MB-capped collector `exec` uses would corrupt
 * both. The caller bounds the input, and so the output.
 * @param command - Command to execute
 * @param args - Command arguments
 * @param input - Bytes written to stdin, which is then closed
 * @param options - Execution options
 */
export async function execWithInput(
  command: string,
  args: string[],
  input: string | Buffer,
  options: ExecWithInputOptions = {}
): Promise<ExecBufferResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk);
    });
    // A child that exits before reading all of stdin (a bad ref, say) makes
    // the write fail with EPIPE. The close handler reports the real outcome.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);

    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: exitCodeFromClose(code, signal),
      });
    });
  });
}
