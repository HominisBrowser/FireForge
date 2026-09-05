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
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return typeof status.stdout === 'string' && status.stdout.trim().length > 0;
}

const base = process.env['WHITESPACE_CHECK_BASE'];
let failed = 0;
let scope;

if (base) {
  scope = `${base}...HEAD`;
  failed = runGit('range diff check', ['diff', '--check', `${base}...HEAD`, ...pathspecs]);
} else if (hasLocalChanges()) {
  scope = 'worktree and index';
  const unstaged = runGit('unstaged diff check', ['diff', '--check', ...pathspecs]);
  const staged = runGit('staged diff check', ['diff', '--cached', '--check', ...pathspecs]);
  failed = unstaged !== 0 || staged !== 0 ? 1 : 0;
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
  if (offences.length > 0) {
    for (const line of offences) console.error(line);
    failed = 1;
  }
}

if (failed !== 0) {
  console.error(`Whitespace check failed (${scope}).`);
  process.exitCode = 1;
} else {
  console.log(`Whitespace check passed (${scope}).`);
}
