// SPDX-License-Identifier: EUPL-1.2
/**
 * The one way FireForge runs git.
 *
 * Every call is hermetic: the operator's global and system configuration,
 * repository-selecting variables (`GIT_DIR`, `GIT_INDEX_FILE`, …) and outer
 * `git -c` settings are dropped, and the settings below are pinned, so
 * output and object ids are the same on every host. Repository-local
 * configuration still applies.
 *
 * `cwd` is always the repository itself: its top-level directory, or a bare
 * repository's directory. Git does not search parent directories, so a
 * directory that is not a repository fails rather than silently addressing
 * an enclosing one (an engine inside a project checkout, say). Pathspecs are
 * literal. Optional index refreshes are off, so reading a repository never
 * writes its index.
 */
import { isUtf8 } from 'node:buffer';
import { dirname, join, resolve } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists, makeTempDir, remove } from '../kernel/fs.js';
import { runBytes } from '../kernel/process/index.js';
import { tailLines } from '../kernel/text.js';

/**
 * The empty file, as git spells it on every platform. Git for Windows maps
 * this name itself and refuses the native device path.
 */
export const GIT_NULL = '/dev/null';

const PINNED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', GIT_NULL],
  ['core.attributesFile', GIT_NULL],
  ['core.excludesFile', GIT_NULL],
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.quotePath', 'true'],
  ['diff.noprefix', 'false'],
  ['diff.mnemonicPrefix', 'false'],
  ['diff.renames', 'false'],
  ['diff.algorithm', 'myers'],
  ['diff.indentHeuristic', 'true'],
  ['diff.context', '3'],
  ['diff.interHunkContext', '0'],
  ['diff.suppressBlankEmpty', 'false'],
  ['merge.conflictStyle', 'merge'],
  ['color.ui', 'false'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  // No background `gc --auto` detaching from a FireForge command.
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
];

/** Inherited `GIT_*` variables that select a transport or trace output, never a repository. */
const KEPT_GIT_VARIABLE =
  /^GIT_(?:EXEC_PATH|SSH|SSH_COMMAND|SSH_VARIANT|SSL_\w+|PROXY_\w+|ASKPASS|TRACE\w*|CURL_VERBOSE)$/;

/** How one git call runs. */
export interface GitOptions {
  /** The repository (see the module comment). */
  cwd: string;
  /** Written to git's stdin. */
  input?: string | Uint8Array;
  /** A scratch index file used instead of the repository's own (`GIT_INDEX_FILE`). */
  index?: string;
  /** Extra settings for this call, passed as `-c key=value`. */
  config?: Readonly<Record<string, string>>;
  /** Extra environment variables. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** How a git call ended. A non-zero exit is a result here, not an exception. */
export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

function environment(options: GitOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_') && !KEPT_GIT_VARIABLE.test(key)) env[key] = undefined;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: GIT_NULL,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_CEILING_DIRECTORIES: dirname(resolve(options.cwd)),
    // Messages are parsed (`git apply`'s rejects), so they must not be translated.
    LC_ALL: 'C',
    GIT_CONFIG_COUNT: String(PINNED_CONFIG.length),
  });
  for (const [index, [key, value]] of PINNED_CONFIG.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  if (options.index !== undefined) env['GIT_INDEX_FILE'] = options.index;
  return { ...env, ...options.env };
}

function notARepository(cwd: string, cause?: unknown): FireForgeError {
  return new FireForgeError('git-not-a-repository', `${cwd} is not a git repository.`, {
    exitCode: ExitCode.GIT_ERROR,
    cause,
  });
}

/**
 * The error for a failed git call: `git-not-a-repository`, `git-index-locked`
 * or `git-failed`, with git's stderr in the message and the cause.
 *
 * @param args - The arguments after `git`
 * @param result - How the call ended
 * @param cwd - The repository
 */
export function gitFailure(
  args: readonly string[],
  result: GitResult,
  cwd: string
): FireForgeError {
  const stderr = result.stderr.trim();
  const cause = new Error(stderr);
  if (/not a git repository/i.test(stderr)) return notARepository(cwd, cause);
  const lock = /Unable to create '([^']*index\.lock)'/.exec(stderr)?.[1];
  if (lock !== undefined) {
    return new FireForgeError('git-index-locked', `The git index of ${cwd} is locked.`, {
      exitCode: ExitCode.GIT_ERROR,
      hint: `Another git process is using it. If none is running, remove ${lock}.`,
      cause,
    });
  }
  const command = `git ${args.join(' ')}`;
  const tail = tailLines(stderr, 10);
  return new FireForgeError(
    'git-failed',
    `${command.length > 200 ? `${command.slice(0, 200)}…` : command} failed (exit ${result.exitCode})` +
      (tail.length === 0 ? '.' : `:\n${tail.map((line) => `  ${line}`).join('\n')}`),
    { exitCode: ExitCode.GIT_ERROR, cause }
  );
}

/**
 * Runs git and returns how it ended, whatever the exit code. For commands
 * whose exit code is an answer (`check-ignore`, `merge-base --is-ancestor`).
 *
 * @param args - The arguments after `git`
 * @param options - See {@link GitOptions}
 */
export async function gitResult(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const config = Object.entries(options.config ?? {}).flatMap(([key, value]) => [
    '-c',
    `${key}=${value}`,
  ]);
  try {
    return await runBytes('git', ['--no-pager', ...config, ...args], {
      cwd: options.cwd,
      env: environment(options),
      ...(options.input !== undefined && { input: options.input }),
    });
  } catch (error: unknown) {
    // A missing working directory fails the spawn the way a missing program does.
    if (!(await exists(options.cwd))) throw notARepository(options.cwd, error);
    throw error;
  }
}

/**
 * Runs git and returns stdout as bytes; a non-zero exit throws.
 *
 * @param args - The arguments after `git`
 * @param options - See {@link GitOptions}
 */
export async function gitBytes(args: readonly string[], options: GitOptions): Promise<Buffer> {
  const result = await gitResult(args, options);
  if (result.exitCode !== 0) throw gitFailure(args, result, options.cwd);
  return result.stdout;
}

/**
 * Runs git and returns stdout as text; a non-zero exit throws.
 *
 * @param args - The arguments after `git`
 * @param options - See {@link GitOptions}
 */
export async function git(args: readonly string[], options: GitOptions): Promise<string> {
  return (await gitBytes(args, options)).toString('utf8');
}

/**
 * Splits NUL-terminated `-z` output into paths. Git paths are bytes; one
 * that is not UTF-8 is refused rather than silently renamed.
 *
 * @param output - The output
 */
export function nulFields(output: Buffer): string[] {
  if (!isUtf8(output)) {
    throw new FireForgeError('git-path-encoding', 'git reported a path that is not valid UTF-8.', {
      exitCode: ExitCode.GIT_ERROR,
      hint: 'Rename the file to a UTF-8 name.',
    });
  }
  const fields = output.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

/**
 * Groups paths so each group's arguments stay well under the smallest
 * historical argument-length limit (256 KiB), with room for the environment.
 *
 * @param paths - The paths
 * @param budget - Bytes per group
 */
export function chunkPaths(paths: readonly string[], budget = 96_000): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const path of paths) {
    const cost = Buffer.byteLength(path) + 1;
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(path);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Runs a `-z` listing command over `paths` in argument-sized chunks (once,
 * unscoped, when `paths` is undefined) and returns the union of its output.
 *
 * @param args - The command, without `--` and paths
 * @param paths - Pathspecs, or undefined for the whole repository
 * @param options - See {@link GitOptions}
 */
export async function listPaths(
  args: readonly string[],
  paths: readonly string[] | undefined,
  options: GitOptions
): Promise<string[]> {
  if (paths === undefined) return nulFields(await gitBytes(args, options));
  const found = new Set<string>();
  for (const chunk of chunkPaths(paths)) {
    for (const path of nulFields(await gitBytes([...args, '--', ...chunk], options)))
      found.add(path);
  }
  return [...found];
}

/**
 * Runs `task` with a scratch index, so nothing in the repository's own index
 * moves: dry runs, snapshots and tree construction work here. The index
 * starts as `seed` (a tree-ish) or empty, and is deleted afterwards.
 *
 * @param cwd - The repository
 * @param seed - Tree-ish to start from, or undefined for an empty index
 * @param task - Receives the index file's path, for {@link GitOptions.index}
 */
export async function withPrivateIndex<T>(
  cwd: string,
  seed: string | undefined,
  task: (index: string) => Promise<T>
): Promise<T> {
  const directory = await makeTempDir('fireforge-index-');
  const index = join(directory, 'index');
  try {
    if (seed !== undefined) await git(['read-tree', seed], { cwd, index });
    return await task(index);
  } finally {
    await remove(directory);
  }
}
