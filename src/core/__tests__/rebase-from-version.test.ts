// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import {
  formatPatchStampSpread,
  readCommittedFirefoxPin,
  resolveRebaseFromVersion,
  tallyPatchStamps,
} from '../rebase-from-version.js';

function config(firefox: unknown): string {
  return JSON.stringify({ name: 'x', firefox }, null, 2);
}

describe('readCommittedFirefoxPin', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject();
  });

  afterEach(async () => {
    await removeTempProject(root);
  });

  it('reads the pin committed at HEAD, not the working copy', async () => {
    await initCommittedRepo(root, {
      'fireforge.json': config({ version: '153.3.0esr', product: 'firefox-esr' }),
    });
    await writeFiles(root, {
      'fireforge.json': config({ version: '153.4.0esr', product: 'firefox-esr' }),
    });

    await expect(readCommittedFirefoxPin(root)).resolves.toEqual({
      version: '153.3.0esr',
      product: 'firefox-esr',
    });
  });

  it('resolves the config relative to a project nested in a larger repository', async () => {
    await initCommittedRepo(root, {
      'browser/fireforge.json': config({ version: '140.0esr', product: 'nonsense' }),
    });

    await expect(readCommittedFirefoxPin(join(root, 'browser'))).resolves.toEqual({
      version: '140.0esr',
    });
  });

  it('returns undefined without a repository, a committed config, or a valid pin', async () => {
    await expect(readCommittedFirefoxPin(root)).resolves.toBeUndefined();
    await expect(readCommittedFirefoxPin(join(root, 'missing'))).resolves.toBeUndefined();

    await initCommittedRepo(root, { 'other.txt': 'x' });
    await expect(readCommittedFirefoxPin(root)).resolves.toBeUndefined();
  });

  it.each([
    ['broken JSON', '{ broken'],
    ['no firefox block', JSON.stringify({ name: 'x' })],
    ['an invalid version', config({ version: 'latest' })],
  ])('returns undefined for %s', async (_label, content) => {
    await initCommittedRepo(root, { 'fireforge.json': content });
    await expect(readCommittedFirefoxPin(root)).resolves.toBeUndefined();
  });
});

describe('patch stamp spread', () => {
  it('orders stamps semantically and formats the counts', () => {
    const spread = tallyPatchStamps(['153.10.0esr', '153.2.0esr', '153.10.0esr']);
    expect(spread.versions).toEqual(['153.2.0esr', '153.10.0esr']);
    expect(formatPatchStampSpread(spread)).toBe('1 at 153.2.0esr, 2 at 153.10.0esr');
  });
});

describe('resolveRebaseFromVersion', () => {
  const spread = tallyPatchStamps(['153.0esr', '153.3.0esr']);

  it('prefers a committed pin that differs from the target', () => {
    expect(
      resolveRebaseFromVersion(
        '153.4.0esr',
        { version: '153.3.0esr', product: 'firefox-esr' },
        spread,
        undefined
      )
    ).toEqual({ version: '153.3.0esr', product: 'firefox-esr', origin: 'committed-pin' });
  });

  it('falls back to the oldest stamp when the committed pin is the target or absent', () => {
    expect(
      resolveRebaseFromVersion('153.4.0esr', { version: '153.4.0esr' }, spread, 'firefox-esr')
    ).toEqual({ version: '153.0esr', product: 'firefox-esr', origin: 'patch-stamps' });
    expect(resolveRebaseFromVersion('153.4.0esr', undefined, spread, undefined)).toEqual({
      version: '153.0esr',
      origin: 'patch-stamps',
    });
  });

  it('uses the target when the queue has no stamps', () => {
    expect(
      resolveRebaseFromVersion('153.4.0esr', undefined, tallyPatchStamps([]), undefined)
    ).toEqual({ version: '153.4.0esr', origin: 'patch-stamps' });
  });
});
