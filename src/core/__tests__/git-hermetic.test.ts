// SPDX-License-Identifier: EUPL-1.2
/**
 * Every FireForge Git call runs under one hermetic configuration, so the
 * operator's own Git setup cannot change which upstream files the engine
 * baseline indexes or the bytes of a generated patch. Real git, hostile
 * global configuration.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { initRepository } from '../git.js';
import { git } from '../git-base.js';
import { getAllDiff } from '../git-diff.js';

const HOSTILE_VARS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
] as const;

describe('hermetic git (hostile operator configuration)', () => {
  let root: string;
  let operator: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    root = await createTempProject('ff-hermetic-git-');
    operator = await createTempProject('ff-hermetic-operator-');
    for (const key of HOSTILE_VARS) saved.set(key, process.env[key]);

    await mkdir(join(operator, 'hooks'));
    await writeFile(join(operator, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(join(operator, 'excludes'), 'build/\n*.log\n');
    await mkdir(join(operator, 'xdg', 'git'), { recursive: true });
    await writeFile(join(operator, 'xdg', 'git', 'ignore'), 'lib/\n');
    await writeFile(
      join(operator, 'gitconfig'),
      [
        '[diff]',
        '  noprefix = true',
        '  renames = false',
        '  algorithm = patience',
        '[color]',
        '  ui = always',
        '[core]',
        `  excludesFile = ${join(operator, 'excludes')}`,
        `  hooksPath = ${join(operator, 'hooks')}`,
        '[commit]',
        '  gpgsign = true',
        '[gpg]',
        '  program = /nonexistent/gpg',
        '[user]',
        '  name = Operator',
        '  email = operator@example.invalid',
        '',
      ].join('\n')
    );
    process.env['HOME'] = operator;
    process.env['XDG_CONFIG_HOME'] = join(operator, 'xdg');
    process.env['GIT_CONFIG_GLOBAL'] = join(operator, 'gitconfig');
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'core.excludesFile';
    process.env['GIT_CONFIG_VALUE_0'] = join(operator, 'excludes');
  });

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await removeTempProject(root);
    await removeTempProject(operator);
  });

  it('indexes every upstream file in the baseline and commits as the pinned identity', async () => {
    const files = ['src/a.cpp', 'build/moz.build', 'lib/x.js', 'logs/run.log'];
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), `${file}\n`);
    }
    await initRepository(root);

    const tracked = (await git(['ls-files'], root)).split('\n').filter(Boolean);
    expect(tracked.sort()).toEqual([...files].sort());
    expect((await git(['log', '-1', '--format=%an'], root)).trim()).toBe('FireForge');
  });

  it('renders patches with a/ b/ prefixes, no colour and rename detection', async () => {
    await writeFile(join(root, 'f.txt'), 'one\n');
    await writeFile(join(root, 'gone.txt'), 'x\n'.repeat(20));
    await initRepository(root);

    await writeFile(join(root, 'f.txt'), 'two\n');
    const diff = await getAllDiff(root);
    expect(diff).toContain('diff --git a/f.txt b/f.txt');
    // eslint-disable-next-line no-control-regex -- asserting the absence of ANSI colour
    expect(diff).not.toMatch(/\u001b\[/);
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('two\n');
  });
});
