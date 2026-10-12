// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins the `--files` argument shape: export-style space-separated paths
 * after `re-export <patch> --files` are folded into the file list instead of
 * erroring with a message that blames the patch argument.
 */
import { describe, expect, it } from 'vitest';

import {
  normalizeReExportFilesPositionals,
  validateReExportOptionCombinations,
} from '../re-export-options.js';

describe('normalizeReExportFilesPositionals', () => {
  it('folds path-shaped extra positionals into the --files list', () => {
    const result = normalizeReExportFilesPositionals(
      ['006-ui-panel.patch', 'browser/components/foo.mjs', 'browser/themes/shared/foo.css'],
      { files: ['browser/base/content/bar.js'] }
    );
    expect(result.patches).toEqual(['006-ui-panel.patch']);
    expect(result.options.files).toEqual([
      'browser/base/content/bar.js',
      'browser/components/foo.mjs',
      'browser/themes/shared/foo.css',
    ]);
    expect(result.foldedPaths).toEqual([
      'browser/components/foo.mjs',
      'browser/themes/shared/foo.css',
    ]);
  });

  it('does not fold when an extra positional is another patch identifier', () => {
    const result = normalizeReExportFilesPositionals(
      ['006-ui-panel.patch', '007-ui-toolbar.patch'],
      { files: ['browser/base/content/bar.js'] }
    );
    expect(result.patches).toHaveLength(2);
    expect(result.foldedPaths).toEqual([]);
    // ...and the multi-patch shape still fails validation with the
    // comma-form guidance.
    expect(() => {
      validateReExportOptionCombinations(result.patches, result.options);
    }).toThrow(/exactly one target patch[\s\S]*comma-separated/);
  });

  it('is a no-op without --files or with a single positional', () => {
    const noFiles = normalizeReExportFilesPositionals(['006-a.patch', 'b/c.js'], {});
    expect(noFiles.patches).toEqual(['006-a.patch', 'b/c.js']);
    const single = normalizeReExportFilesPositionals(['006-a.patch'], { files: ['x/y.js'] });
    expect(single.patches).toEqual(['006-a.patch']);
    expect(single.foldedPaths).toEqual([]);
  });

  it('single-patch --files passes validation after folding', () => {
    const result = normalizeReExportFilesPositionals(['006-a.patch', 'browser/x.js'], {
      files: ['browser/y.js'],
    });
    expect(() => {
      validateReExportOptionCombinations(result.patches, result.options);
    }).not.toThrow();
  });
});

describe('--expect-unmanaged', () => {
  it('is refused without --refuse-adjacent-unmanaged', () => {
    // A carve-out for a refusal that was never armed is worse than an error:
    // the operator believes an exception is in force when nothing is.
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        expectUnmanaged: ['browser/themes/shared/hominis/fonts/nebula-sans-regular.woff2'],
      });
    }).toThrow(/--expect-unmanaged names approved exceptions/);
  });

  it('is accepted alongside --refuse-adjacent-unmanaged', () => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        refuseAdjacentUnmanaged: true,
        expectUnmanaged: ['browser/themes/shared/hominis/fonts/nebula-sans-regular.woff2'],
      });
    }).not.toThrow();
  });

  it('inherits the scan-less restriction from its parent flag', () => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        refuseAdjacentUnmanaged: true,
        scan: true,
        expectUnmanaged: ['browser/themes/shared/hominis/fonts/nebula-sans-regular.woff2'],
      });
    }).toThrow(/--refuse-adjacent-unmanaged applies to the scan-less path only/);
  });
});

describe('--expect-new and --adjacent-ignore', () => {
  it('are refused without --refuse-adjacent-unmanaged', () => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        expectNew: ['browser/modules/hominis/HominisBangs.sys.mjs'],
      });
    }).toThrow(/--expect-new relaxes --refuse-adjacent-unmanaged/);
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        adjacentIgnore: ['widget/headless/tests/lab/*.json'],
      });
    }).toThrow(/--adjacent-ignore relaxes --refuse-adjacent-unmanaged/);
  });

  it('refuses a ** ignore entry, which would span subtrees', () => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        refuseAdjacentUnmanaged: true,
        adjacentIgnore: ['widget/headless/**'],
      });
    }).toThrow(/\*\* is refused/);
  });

  it('accepts both alongside --refuse-adjacent-unmanaged', () => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        refuseAdjacentUnmanaged: true,
        expectNew: ['browser/modules/hominis/HominisBangs.sys.mjs'],
        adjacentIgnore: ['widget/headless/tests/lab/*.json'],
      });
    }).not.toThrow();
  });
});

describe('path flag values that are flags', () => {
  it.each([
    ['expect', '--expect', { refuseForeignDrift: true }],
    ['expectUnmanaged', '--expect-unmanaged', { refuseAdjacentUnmanaged: true }],
    ['expectNew', '--expect-new', { refuseAdjacentUnmanaged: true }],
    ['adjacentIgnore', '--adjacent-ignore', { refuseAdjacentUnmanaged: true }],
    ['scanFiles', '--scan-file', { scan: true }],
    ['expectRemoved', '--expect-removed', {}],
  ] as const)('refuses a %s value that starts with a dash', (key, flag, extra) => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        ...extra,
        [key]: ['comp/a.js', '--dry-run'],
      });
    }).toThrow(`${flag} was given "--dry-run", which is a flag, not an engine path`);
  });

  it('names the swallowed flag before any combination error it would trip', () => {
    // `--expect --refuse-foreign-drift` swallows the very flag --expect
    // needs; the combination error alone would blame the wrong thing.
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        expect: ['--refuse-foreign-drift'],
      });
    }).toThrow(/--expect was given "--refuse-foreign-drift"/);
  });

  it('refuses a short flag swallowed as a value too', () => {
    expect(() => {
      validateReExportOptionCombinations(['101-fonts.patch'], {
        refuseAdjacentUnmanaged: true,
        expectUnmanaged: ['-y'],
      });
    }).toThrow(/--expect-unmanaged was given "-y"/);
  });
});
