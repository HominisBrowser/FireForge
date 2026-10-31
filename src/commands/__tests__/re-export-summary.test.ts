// SPDX-License-Identifier: EUPL-1.2
/**
 * The end-of-run summary of a multi-patch `re-export`: a nine-patch run
 * that wrote eight and failed one on lint left the two sets to be told
 * apart by grepping a long log.
 */
import { describe, expect, it } from 'vitest';

import { formatCheckJsProjectPassNote, formatReExportRunSummary } from '../re-export-summary.js';

const base = {
  failed: [],
  refusedAdjacent: [],
  refusedDrift: [],
  isDryRun: false,
};

describe('formatReExportRunSummary', () => {
  it('says nothing for a single-patch run', () => {
    expect(
      formatReExportRunSummary({ ...base, selected: ['001-a.patch'], written: [] })
    ).toBeUndefined();
  });

  it('names every unwritten patch with its reason, after the written ones', () => {
    expect(
      formatReExportRunSummary({
        selected: ['001-a.patch', '002-b.patch', '003-c.patch', '004-d.patch', '005-e.patch'],
        written: ['001-a.patch'],
        failed: ['002-b.patch'],
        refusedAdjacent: ['003-c.patch'],
        refusedDrift: ['004-d.patch'],
        isDryRun: false,
      })
    ).toBe(
      'Re-export summary: wrote 1 of 5: 001-a.patch; NOT written: 002-b.patch (failed), ' +
        '003-c.patch (refused: adjacent unmanaged), 004-d.patch (refused: foreign drift), ' +
        '005-e.patch (skipped).'
    );
  });

  it('names the patches a drift refusal held back, in the conditional for a dry run', () => {
    expect(
      formatReExportRunSummary({
        ...base,
        selected: ['001-a.patch', '002-b.patch'],
        written: [],
        refusedDrift: ['002-b.patch'],
        heldBack: ['001-a.patch'],
        isDryRun: true,
      })
    ).toBe(
      'Re-export summary: would write 0 of 2; would NOT write: 001-a.patch (held back: another ' +
        'patch refused), 002-b.patch (refused: foreign drift). Nothing would be written because ' +
        '--refuse-foreign-drift refused 002-b.patch.'
    );
  });

  it('reads as a clean run when everything was written', () => {
    expect(
      formatReExportRunSummary({
        ...base,
        selected: ['001-a.patch', '002-b.patch'],
        written: ['001-a.patch', '002-b.patch'],
      })
    ).toBe('Re-export summary: wrote 2 of 2: 001-a.patch, 002-b.patch.');
  });

  it('speaks in the conditional for a dry run with nothing written', () => {
    expect(
      formatReExportRunSummary({
        ...base,
        selected: ['001-a.patch', '002-b.patch'],
        written: [],
        failed: ['001-a.patch', '002-b.patch'],
        isDryRun: true,
      })
    ).toBe(
      'Re-export summary: would write 0 of 2; would NOT write: 001-a.patch (failed), ' +
        '002-b.patch (failed).'
    );
  });
});

describe('formatCheckJsProjectPassNote', () => {
  it('says nothing when no written patch had per-patch checkJs files', () => {
    expect(formatCheckJsProjectPassNote([], false)).toBeUndefined();
  });

  it('names the patches and owes the project pass', () => {
    expect(formatCheckJsProjectPassNote(['001-a.patch', '002-b.patch'], false)).toBe(
      'Per-patch checkJs only (001-a.patch, 002-b.patch): it is not the project pass, which can ' +
        'still report errors in these files. Run "fireforge typecheck" for the project pass ' +
        'before committing.'
    );
    expect(formatCheckJsProjectPassNote(['001-a.patch'], true)).toMatch(
      /Run "fireforge typecheck" for the project pass once the patches are written\.$/
    );
  });
});
