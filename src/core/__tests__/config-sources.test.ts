// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateConfig } from '../config-validate.js';

const identity = {
  name: 'Fixture',
  vendor: 'Fixture',
  binaryName: 'fixture',
  appId: 'invalid.example.fixture',
  firefox: { version: '153.6.0esr', product: 'firefox-esr' },
};
const sources = {
  schemaVersion: 1,
  mode: 'authored',
  root: 'src',
  metadataRoot: '.fireforge-sources',
  pristineCommit: 'a'.repeat(40),
};

describe('source authority configuration', () => {
  it('requires the existing validated enum fence and supports both Git object formats', () => {
    expect(() => validateConfig({ ...identity, sources })).toThrow('reapOrphans');
    const config = validateConfig({ ...identity, sources, test: { reapOrphans: 'owned' } });
    expect(config.sources?.root).toBe('src');
    expect(
      validateConfig({
        ...identity,
        sources: { ...sources, pristineCommit: 'b'.repeat(64) },
        test: { reapOrphans: 'owned' },
      }).sources?.pristineCommit
    ).toHaveLength(64);
  });

  it.each([
    { schemaVersion: 2 },
    { mode: 'unknown' },
    { root: '../outside' },
    { root: 'engine' },
    { root: 'Engine' },
    { root: '.git' },
    { root: 'src/../other' },
    { root: ' src' },
    { root: 'src\\other' },
    { metadataRoot: 'src/metadata' },
    { pristineCommit: 'HEAD' },
    { unknownFeature: true },
    { root: 'src//nested' },
    { metadataRoot: 'node_modules/meta' },
  ])('refuses malformed or unsafe source configuration %j', (change) => {
    expect(() =>
      validateConfig({
        ...identity,
        sources: { ...sources, ...change },
        test: { reapOrphans: 'owned' },
      })
    ).toThrow();
  });
});
