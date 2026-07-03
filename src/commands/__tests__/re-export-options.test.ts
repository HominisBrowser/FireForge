// SPDX-License-Identifier: EUPL-1.2
/**
 * Pins the 0.34.0 `--files` argument-shape fix: export-style
 * space-separated paths after `re-export <patch> --files` are folded into
 * the file list instead of erroring with a message that blames the patch
 * argument.
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
