// SPDX-License-Identifier: EUPL-1.2
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { type FileTree, writeTree } from './temp.js';

const execFileAsync = promisify(execFile);

/**
 * Whether the git on PATH is 2.44 or later, the first to pass the ancestor
 * label to a merge driver. First-touch merges need it; an older git gets the
 * documented add/add conflict instead.
 */
export const GIT_PASSES_ANCESTOR_LABEL: boolean = (() => {
  const version = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  const [major, minor] = [Number(version?.[1] ?? 0), Number(version?.[2] ?? 0)];
  return major > 2 || (major === 2 && minor >= 44);
})();

/**
 * Runs git in a repository and returns its stdout. A non-zero exit rejects.
 *
 * @param cwd - The repository
 * @param args - Arguments after `git`
 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitBytes(cwd, args)).toString('utf8');
}

/**
 * Runs git in a repository and returns its stdout as raw bytes, for output
 * that need not be UTF-8 (diffs of Latin-1 files, blobs). A non-zero exit rejects.
 *
 * @param cwd - The repository
 * @param args - Arguments after `git`
 * @param input - Written to stdin
 */
export async function gitBytes(
  cwd: string,
  args: readonly string[],
  input?: string | Uint8Array
): Promise<Buffer> {
  const pending = execFileAsync('git', [...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    // A test repository must not pick up the developer's or the host's git configuration.
    env: {
      ...process.env,
      // Git's own name for the empty file; Git for Windows refuses the native one.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      // With no configuration to read, a commit needs its identity from here.
      GIT_AUTHOR_NAME: 'FireForge Tests',
      GIT_AUTHOR_EMAIL: 'fireforge@example.test',
      GIT_COMMITTER_NAME: 'FireForge Tests',
      GIT_COMMITTER_EMAIL: 'fireforge@example.test',
    },
  });
  if (input !== undefined) pending.child.stdin?.end(input);
  return (await pending).stdout;
}

/**
 * Stages everything and commits it.
 *
 * @param cwd - The repository
 * @param message - The commit message
 * @returns The new commit's hash
 */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '--allow-empty', '-m', message]);
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Turns a directory into a real git repository with one commit holding
 * `files`. Identity and line endings are pinned, so hashes and patch bytes
 * are the same on every host.
 *
 * @param directory - The directory; created if absent
 * @param files - Contents of the first commit
 * @returns The first commit's hash
 */
export async function initRepo(directory: string, files: FileTree = {}): Promise<string> {
  await writeTree(directory, files);
  await git(directory, ['init', '--initial-branch', 'main']);
  await git(directory, ['config', 'user.email', 'fireforge@example.test']);
  await git(directory, ['config', 'user.name', 'FireForge Tests']);
  await git(directory, ['config', 'core.autocrlf', 'false']);
  await git(directory, ['config', 'core.eol', 'lf']);
  await git(directory, ['config', 'commit.gpgsign', 'false']);
  return commitAll(directory, 'initial');
}
