// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { escapeRegExp } from '../kernel/text.js';
import { cliVersion, formatVersion, packageRoot, packageVersion } from './version.js';

describe('version', () => {
  it.each([
    [undefined, '1.2.3'],
    [{ shortCommit: 'abc123def456', dirty: false }, '1.2.3+gabc123def456'],
    [{ shortCommit: 'abc123def456', dirty: true }, '1.2.3+gabc123def456.dirty'],
    [
      { shortCommit: 'abc123def456', dirty: true, dirtyHash: '0f0f0f0f' },
      '1.2.3+gabc123def456.dirty.0f0f0f0f',
    ],
  ])('formats %j', (identity, expected) => {
    expect(formatVersion('1.2.3', identity)).toBe(expected);
  });

  it('finds the package this code belongs to', async () => {
    const root = await packageRoot();
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string;
      bin: { fireforge: string };
    };
    expect(manifest.bin.fireforge).toBeDefined();
    expect(await packageVersion()).toBe(manifest.version);
    expect(await cliVersion()).toMatch(
      new RegExp(`^${escapeRegExp(manifest.version)}(\\+g[0-9a-f]{12}(\\.dirty)?)?$`)
    );
  });
});
