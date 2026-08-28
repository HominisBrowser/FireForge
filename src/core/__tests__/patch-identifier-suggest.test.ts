// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchMetadata } from '../../types/commands/index.js';
import { formatPatchNotFoundError } from '../patch-identifier-suggest.js';

function makePatch(filename: string, name: string, order: number): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name,
    description: '',
    createdAt: '2026-04-26T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
  };
}

describe('formatPatchNotFoundError', () => {
  it('does not enumerate the full queue inline on a 29-patch manifest', () => {
    // Building `Available: 001-foo, 002-bar, …` from every queued patch's
    // filename and manifest name runs ~1500 characters on a 29-patch queue
    // and buries the actual error in CI logs. The helper never inlines more
    // than three closest suggestions.
    const patches: PatchMetadata[] = Array.from({ length: 29 }, (_, i) =>
      makePatch(`${String(i + 1).padStart(3, '0')}-foo-${i}.patch`, `foo-${i}`, i + 1)
    );
    const message = formatPatchNotFoundError('999-nope', patches);

    // The response should mention the queue size and `patch list` …
    expect(message).toContain('29 patches in the queue');
    expect(message).toContain('fireforge patch list');
    // … and must not list more than three filenames.
    const enumerated = patches.filter((p) => message.includes(p.filename));
    expect(enumerated.length).toBeLessThanOrEqual(3);
    // The three "Did you mean:" candidates plus the full-list pointer
    // keep the total payload tight enough for CI.
    expect(message.length).toBeLessThan(400);
  });

  it('surfaces did-you-mean suggestions for typos within distance 3', () => {
    // A typo on the manifest name should resolve to the closest match.
    const patches = [
      makePatch('001-ui-workbench.patch', 'workbench', 1),
      makePatch('002-ui-dashboard.patch', 'dashboard', 2),
      makePatch('003-infra-storage.patch', 'storage', 3),
    ];
    const message = formatPatchNotFoundError('workbensh', patches);
    expect(message).toContain('Did you mean');
    expect(message).toContain('workbench');
    // Far-distance candidates are not surfaced.
    expect(message).not.toContain('storage');
  });

  it('falls back to a count-only summary when nothing is close', () => {
    // An identifier with no plausible match should not list anything;
    // operators get a "no close match" hint pointing at `patch list`.
    const patches = [
      makePatch('001-ui-workbench.patch', 'workbench', 1),
      makePatch('002-ui-dashboard.patch', 'dashboard', 2),
    ];
    const message = formatPatchNotFoundError('totally-unrelated-string', patches);
    expect(message).toContain('No close match found among 2 patches');
    expect(message).toContain('fireforge patch list');
    // Suggestions section must not appear.
    expect(message).not.toContain('Did you mean');
  });

  it('matches an ordinal typo against the ordinal column', () => {
    // The accepted-identifier set includes the ordinal as a string,
    // so an off-by-one ordinal should suggest the closest neighbour.
    const patches = [
      makePatch('001-foo.patch', 'foo', 1),
      makePatch('002-bar.patch', 'bar', 2),
      makePatch('003-baz.patch', 'baz', 3),
    ];
    const message = formatPatchNotFoundError('22', patches);
    expect(message).toContain('Did you mean');
    expect(message).toContain('2');
  });

  it('matches a filename-without-extension form', () => {
    // Operators frequently paste the filename without the `.patch`
    // suffix (e.g. from `patch list` summaries). Both shapes round-
    // trip through the suggestion ranker.
    const patches = [makePatch('001-ui-workbench.patch', 'workbench', 1)];
    const message = formatPatchNotFoundError('001-ui-workbenc', patches);
    expect(message).toContain('Did you mean');
    expect(message).toContain('001-ui-workbench');
  });
});

describe('prefix-based suggestions', () => {
  it('suggests the full identifier from a typed abbreviation, beyond edit distance', () => {
    const patches = [
      makePatch('001-ui-tab-strip-overhaul.patch', 'tab-strip-overhaul', 1),
      makePatch('002-infra-storage.patch', 'storage', 2),
    ];
    // Nine edits away from the filename — pure edit distance would miss it.
    const message = formatPatchNotFoundError('001-ui-tab', patches);
    expect(message).toContain('Did you mean');
    expect(message).toContain('001-ui-tab-strip-overhaul');
    expect(message).not.toContain('002-infra-storage');
  });

  it('does not let a one-character ordinal prefix-match everything', () => {
    const patches = Array.from({ length: 9 }, (_, i) =>
      makePatch(`00${String(i + 1)}-foo-${String(i)}.patch`, `foo-${String(i)}`, i + 1)
    );
    const message = formatPatchNotFoundError('9zz-nonsense', patches);
    expect(message).toContain('No close match');
  });
});
