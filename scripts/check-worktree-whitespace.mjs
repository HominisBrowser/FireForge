#!/usr/bin/env node
// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';

const pathspecs = ['--', '.', ':(exclude)patches/*.patch'];

function runGitDiffCheck(label, args) {
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

const unstaged = runGitDiffCheck('unstaged diff check', ['diff', '--check', ...pathspecs]);
const staged = runGitDiffCheck('staged diff check', ['diff', '--cached', '--check', ...pathspecs]);

if (unstaged !== 0 || staged !== 0) {
  process.exitCode = 1;
} else {
  console.log('Worktree whitespace check passed.');
}
