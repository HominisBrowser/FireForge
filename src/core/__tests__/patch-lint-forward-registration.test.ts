// SPDX-License-Identifier: EUPL-1.2
/**
 * The narrow half of the forward-registration rule: what counts as a
 * `support-files` entry, and what a resolved entry matches. The rule refuses
 * a queue, so every shape it cannot parse with certainty must yield NOTHING
 * rather than a guess.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSupportFileMatcher,
  extractSupportFileEntries,
  lintPatchQueueForwardRegistrations,
} from '../patch-lint-forward-registration.js';

describe('extractSupportFileEntries', () => {
  it('reads a single-line TOML array, pairing each entry with its own line', () => {
    expect(extractSupportFileEntries('support-files = ["fixtures/*.sqlite", "head.js"]')).toEqual([
      {
        entry: 'fixtures/*.sqlite',
        line: 'support-files = ["fixtures/*.sqlite", "head.js"]',
        occurrences: 1,
      },
      {
        entry: 'head.js',
        line: 'support-files = ["fixtures/*.sqlite", "head.js"]',
        occurrences: 1,
      },
    ]);
  });

  it('attributes each element of a multi-line array to its own line', () => {
    const content = ['support-files = [', '  "a.json",', '  "b.json",', ']'].join('\n');
    expect(extractSupportFileEntries(content)).toEqual([
      { entry: 'a.json', line: '"a.json",', occurrences: 1 },
      { entry: 'b.json', line: '"b.json",', occurrences: 1 },
    ]);
  });

  it('reads the whitespace-separated .ini spelling', () => {
    expect(extractSupportFileEntries('support-files = a.json b.json')).toEqual([
      { entry: 'a.json', line: 'support-files = a.json b.json', occurrences: 1 },
      { entry: 'b.json', line: 'support-files = a.json b.json', occurrences: 1 },
    ]);
  });

  it('deduplicates an entry listed under several sections and counts its lines', () => {
    // The shape 111's browser.toml has: two per-test sections listing the
    // same support file. One declaration covers the file, so the entry is
    // reported once, with the count that lets the message say so.
    const content = [
      '["browser_a.js"]',
      'support-files = ["shared.html"]',
      '',
      '["browser_b.js"]',
      'support-files = ["shared.html", "extra.html"]',
    ].join('\n');
    expect(extractSupportFileEntries(content)).toEqual([
      { entry: 'shared.html', line: 'support-files = ["shared.html"]', occurrences: 2 },
      {
        entry: 'extra.html',
        line: 'support-files = ["shared.html", "extra.html"]',
        occurrences: 1,
      },
    ]);
  });

  it('ignores every other key', () => {
    expect(extractSupportFileEntries('generated-files = ["x"]\nhead = "head.js"')).toEqual([]);
  });

  it('does not walk the file on an unterminated array', () => {
    const content = [
      'support-files = [',
      ...Array.from({ length: 400 }, (_unused, i) => `  "x${i}.json",`),
    ].join('\n');
    // Bounded scan: it stops rather than accumulating the whole manifest.
    expect(extractSupportFileEntries(content).length).toBeLessThan(400);
  });
});

describe('buildSupportFileMatcher', () => {
  const manifest = 'browser/modules/test/unit/xpcshell.toml';

  it('resolves a plain entry against the manifest directory', () => {
    const matches = buildSupportFileMatcher(manifest, 'fixtures/schema.sqlite');
    expect(matches?.('browser/modules/test/unit/fixtures/schema.sqlite')).toBe(true);
    expect(matches?.('browser/modules/other/fixtures/schema.sqlite')).toBe(false);
  });

  it('expands a * inside one path segment', () => {
    const matches = buildSupportFileMatcher(manifest, 'fixtures/*.sqlite');
    expect(matches?.('browser/modules/test/unit/fixtures/schema-v32.sqlite')).toBe(true);
    expect(matches?.('browser/modules/test/unit/fixtures/schema.json')).toBe(false);
    // A single `*` must not cross a directory boundary.
    expect(matches?.('browser/modules/test/unit/fixtures/deep/schema.sqlite')).toBe(false);
  });

  it('declines shapes it cannot resolve with certainty', () => {
    // Each of these would make the rule attribute a creation to the wrong
    // manifest, and the rule refuses a queue, so it must decline instead.
    expect(buildSupportFileMatcher(manifest, '**/*.sqlite')).toBeUndefined();
    expect(buildSupportFileMatcher(manifest, '!excluded.sqlite')).toBeUndefined();
    expect(buildSupportFileMatcher(manifest, '/abs/path.sqlite')).toBeUndefined();
    // Only an entry that leaves the engine root is declined. A
    // parent-relative entry that stays inside it resolves normally.
    expect(buildSupportFileMatcher(manifest, '../../../../../escape.sqlite')).toBeUndefined();
    expect(
      buildSupportFileMatcher(
        manifest,
        '../shared/head.js'
      )?.('browser/modules/test/shared/head.js')
    ).toBe(true);
  });
});

describe('lintPatchQueueForwardRegistrations scope', () => {
  const entry = (
    filename: string,
    order: number,
    manifestPath: string,
    created: string[] = []
  ): Parameters<typeof lintPatchQueueForwardRegistrations>[0]['entries'][number] => ({
    filename,
    order,
    newFiles: new Map(),
    modifiedFileAdditions: new Map([[manifestPath, 'support-files = ["fixtures/*.sqlite"]']]),
    createdFiles: new Set(created),
    metadata: null,
  });

  it('ignores a manifest basename outside the closed list', () => {
    // "anything .toml" would sweep in Cargo and taskcluster manifests whose
    // support-files-shaped keys mean something else.
    const issues = lintPatchQueueForwardRegistrations({
      entries: [
        entry('001.patch', 1, 'build/Cargo.toml'),
        entry('002.patch', 2, 'unused.toml', ['build/fixtures/x.sqlite']),
      ],
    });
    expect(issues).toEqual([]);
  });

  it('flags a recognised manifest', () => {
    const issues = lintPatchQueueForwardRegistrations({
      entries: [
        entry('001.patch', 1, 'browser/test/xpcshell.toml'),
        entry('002.patch', 2, 'unused.toml', ['browser/test/fixtures/x.sqlite']),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('forward-registration');
  });
});
