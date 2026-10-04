#!/usr/bin/env node
// SPDX-License-Identifier: EUPL-1.2
/**
 * Whitespace-error gate (trailing whitespace, space-before-tab, lone CR).
 *
 * Checks the worktree locally and the commits in CI. The worktree-only form
 * this replaced could not fail where it ran: `release:check` reaches it with
 * a clean tree in both CI workflows, so both `git diff --check` calls exited
 * 0 unconditionally and the gate never inspected anything that had actually
 * been written.
 *
 * Range selection:
 *   - `WHITESPACE_CHECK_BASE` set (CI sets it to the PR base sha)  → `<base>...HEAD`
 *   - otherwise, if the worktree or index is dirty                 → worktree + index
 *   - otherwise                                                    → the tip commit
 */
import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';

const pathspecs = ['--', '.', ':(exclude)patches/*.patch'];

function runGit(label, args) {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    console.error(`Whitespace check failed to run ${label}: ${result.error.message}`);
    return 1;
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  return result.status ?? 1;
}

function hasLocalChanges() {
  const status = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (status.error || status.status !== 0) {
    throw new Error(status.error?.message ?? status.stderr ?? 'Git status failed');
  }
  return typeof status.stdout === 'string' && status.stdout.trim().length > 0;
}

async function checkUntracked() {
  const result = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  let failed = false;
  for (const path of result.stdout.split('\0').filter(Boolean)) {
    if (/^patches\/.*\.patch$/.test(path)) continue;
    // Inspect text inputs, including extensionless configs. Binary inputs and
    // link targets do not have a source-whitespace contract.
    if (!(await lstat(path)).isFile()) continue;
    const content = await readFile(path);
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = i < lines.length - 1 ? lines[i].replace(/\r$/, '') : lines[i];
      const offence = /[ \t]+$/.test(line)
        ? 'trailing whitespace'
        : /^[ \t]* \t/.test(line)
          ? 'space before tab'
          : /\r/.test(line)
            ? 'lone CR'
            : undefined;
      if (offence) {
        console.error(`${path}:${i + 1}: ${offence}`);
        failed = true;
      }
    }
  }
  return failed;
}

const base = process.env['WHITESPACE_CHECK_BASE'];
let failed = 0;
let scope;

try {
  if (base) {
    scope = `${base}...HEAD`;
    failed = runGit('range diff check', ['diff', '--check', `${base}...HEAD`, ...pathspecs]);
  } else if (hasLocalChanges()) {
    scope = 'worktree and index';
    const unstaged = runGit('unstaged diff check', ['diff', '--check', ...pathspecs]);
    const staged = runGit('staged diff check', ['diff', '--cached', '--check', ...pathspecs]);
    failed = unstaged !== 0 || staged !== 0 ? 1 : 0;
    if (await checkUntracked()) failed = 1;
  } else {
    scope = 'tip commit';
    // `git log -p --check` exits 0 even when it reports errors, so the output
    // itself is the signal.
    const result = spawnSync('git', ['log', '-p', '--check', '-1', ...pathspecs], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const offences = output
      .split('\n')
      .filter((line) =>
        /:\d+: (trailing whitespace|space before tab|new blank line at EOF)/.test(line)
      );
    if (result.error || (result.status !== 0 && offences.length === 0)) {
      throw new Error(result.error?.message ?? result.stderr ?? 'Git log failed');
    }
    if (offences.length > 0) {
      for (const line of offences) console.error(line);
      failed = 1;
    }
  }
} catch (error) {
  console.error(`Whitespace check could not inspect Git inputs: ${error.message}`);
  failed = 1;
  scope ??= 'Git input discovery';
}

if (failed !== 0) {
  console.error(`Whitespace check failed (${scope}).`);
  process.exitCode = 1;
} else {
  console.log(`Whitespace check passed (${scope}).`);
}
