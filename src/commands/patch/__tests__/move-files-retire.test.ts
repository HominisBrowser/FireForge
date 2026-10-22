// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit coverage for the pure `move-files --retire-empty` fold helpers:
 * owner re-pointing, declaration merging and the retired slot, exercised
 * directly so each branch is hit without driving the whole command.
 */

import { describe, expect, it } from 'vitest';

import { makePatch } from '../../../test-utils/index.js';
import type { PatchMetadata } from '../../../types/commands/index.js';
import { foldSourceRows, retiredSlotForFold } from '../move-files-retire.js';

const SOURCE = '020-test-a.patch';
const DEST = '010-ui-a.patch';

function row(filename: string, extra: Partial<PatchMetadata> = {}): PatchMetadata {
  return { ...makePatch(filename), ...extra };
}

describe('foldSourceRows', () => {
  it('re-points declarations owned by the source and merges the source declarations', () => {
    const shared = {
      file: 'x/jar.mn',
      line: 'content/a.js',
      creates: 'x/a.js',
      owner: '030-ui-b.patch',
    };
    const patches = [
      row(DEST, { stagedDependencies: { registrations: [shared] } }),
      row(SOURCE, {
        stagedDependencies: {
          // A duplicate of the destination's own entry and one the fold makes
          // internal (the source owned the file itself) are both dropped.
          registrations: [
            shared,
            { file: 'x/jar.mn', line: 'content/s.js', creates: 'x/s.js', owner: SOURCE },
          ],
          forwardImports: [
            {
              file: 'x/i.mjs',
              specifier: './later.mjs',
              creates: 'x/later.mjs',
              owner: '030-ui-b.patch',
            },
          ],
        },
      }),
      row('005-ui-c.patch', {
        stagedDependencies: {
          forwardImports: [
            { file: 'y/i.mjs', specifier: './t.mjs', creates: 'x/t.mjs', owner: SOURCE },
          ],
        },
      }),
      row('030-ui-b.patch'),
    ];

    const folded = foldSourceRows(patches, SOURCE, DEST);

    expect(folded.repointed).toEqual(['005-ui-c.patch']);
    const dest = folded.patches.find((patch) => patch.filename === DEST);
    expect(dest?.stagedDependencies?.registrations).toEqual([shared]);
    expect(dest?.stagedDependencies?.forwardImports).toHaveLength(1);
    const other = folded.patches.find((patch) => patch.filename === '005-ui-c.patch');
    expect(other?.stagedDependencies?.forwardImports?.[0]?.owner).toBe(DEST);
    expect(folded.patches.find((patch) => patch.filename === SOURCE)).toBe(patches[1]);
  });

  it('drops the destination stagedDependencies when nothing is left after the fold', () => {
    const patches = [
      row(DEST, {
        stagedDependencies: {
          forwardImports: [
            { file: 'x/i.mjs', specifier: './s.mjs', creates: 'x/s.mjs', owner: SOURCE },
          ],
        },
      }),
      row(SOURCE),
    ];

    const folded = foldSourceRows(patches, SOURCE, DEST);

    expect(folded.patches[0]?.stagedDependencies).toBeUndefined();
    expect(folded.repointed).toEqual([DEST]);
  });

  it('tolerates a source that is not in the queue', () => {
    const patches = [row(DEST)];
    expect(foldSourceRows(patches, SOURCE, DEST).patches[0]?.stagedDependencies).toBeUndefined();
  });
});

describe('retiredSlotForFold', () => {
  it('records the source slot with a reason naming the destination', () => {
    const source = row(SOURCE, { order: 20, category: 'test' });
    expect(retiredSlotForFold(source, DEST)).toMatchObject({
      order: 20,
      category: 'test',
      filename: SOURCE,
      reason: `folded into ${DEST} by patch move-files --retire-empty`,
    });
  });
});
