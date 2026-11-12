// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** What a finished child process produced. */
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Where and with what environment a child process runs. */
export interface ScriptOptions {
  /** Working directory. */
  cwd: string;
  /** Environment variables added to this process's own. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** A started child process: its eventual result, and the handle for a test that signals it. */
export interface StartedProcess {
  readonly pid: number | undefined;
  readonly result: Promise<ProcessResult>;
  kill(signal: NodeJS.Signals): void;
  /** Resolves, with the stdout so far, once the child's stdout contains `text`. */
  waitForOutput(text: string): Promise<string>;
}

/**
 * Starts a TypeScript entry file in a child Node process.
 *
 * @param entry - Absolute path of the file to run
 * @param args - Its arguments
 * @param options - See {@link ScriptOptions}
 */
export function startScript(
  entry: string,
  args: readonly string[],
  options: ScriptOptions
): StartedProcess {
  // The loader is imported directly: the tsx CLI would add a process in between.
  const loader = pathToFileURL(resolve(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', loader, entry, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const watchers = new Set<() => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (const watcher of watchers) watcher();
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const result = new Promise<ProcessResult>((settle, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      for (const watcher of watchers) watcher();
      settle({ exitCode: code ?? (signal === null ? 1 : 128), stdout, stderr });
    });
  });
  return {
    pid: child.pid,
    result,
    kill: (signal) => void child.kill(signal),
    waitForOutput: (text) =>
      new Promise<string>((seen, missed) => {
        const check = (): void => {
          if (stdout.includes(text)) seen(stdout);
          else if (child.exitCode !== null || child.signalCode !== null) {
            missed(new Error(`exited without printing "${text}":\n${stdout}\n${stderr}`));
          } else return;
          watchers.delete(check);
        };
        watchers.add(check);
        check();
      }),
  };
}

/**
 * The `file:` URL of a source module, for a fixture script that lives outside
 * the repository and imports the code under test.
 *
 * @param path - Path relative to `src/`, such as `kernel/lock.ts`
 */
export function sourceUrl(path: string): string {
  return pathToFileURL(resolve(REPO_ROOT, 'src', path)).href;
}
