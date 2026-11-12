// SPDX-License-Identifier: EUPL-1.2
// The gate before `npm publish`: `npm run release:check`, unless the release
// workflow already ran that gate, split across jobs, on this exact tree. The
// workflow names the commit it verified in FIREFORGE_RELEASE_VERIFIED; the
// gate is skipped only when HEAD differs from it in nothing but the version
// lines a release bump writes to package.json and package-lock.json, and the
// worktree is clean.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BUMPED_FILES = new Set(['package.json', 'package-lock.json']);

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Why HEAD is not the verified tree give or take a version bump, or undefined
 * when it is.
 *
 * @param {string} verified - The commit the workflow verified
 * @param {string} [cwd] - The repository, the current directory by default
 * @returns {string | undefined}
 */
export function differenceFromVerified(verified, cwd = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(verified))
    return `FIREFORGE_RELEASE_VERIFIED is not a commit: ${verified}`;
  if (git(['status', '--porcelain'], cwd).trim() !== '')
    return 'the worktree has uncommitted changes';
  const changed = git(['diff', '--name-only', verified, 'HEAD'], cwd).split('\n').filter(Boolean);
  const other = changed.filter((path) => !BUMPED_FILES.has(path));
  if (other.length > 0) return `HEAD changes ${other.join(', ')} since ${verified}`;
  const lines = git(['diff', '-U0', verified, 'HEAD', '--', ...BUMPED_FILES], cwd)
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
  const unexpected = lines.find((line) => !/^[+-]\s*"version": "[^"]+",?$/.test(line));
  return unexpected === undefined
    ? undefined
    : `HEAD changes more than the version since ${verified}: ${unexpected}`;
}

function main() {
  const verified = process.env.FIREFORGE_RELEASE_VERIFIED;
  if (verified !== undefined && verified !== '') {
    const difference = differenceFromVerified(verified);
    if (difference === undefined) {
      console.log(`Release gate: verified by the release workflow at ${verified}; not run again.`);
      return;
    }
    console.log(`Release gate: running it here, because ${difference}.`);
  }
  const result = spawnSync('npm', ['run', 'release:check'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
