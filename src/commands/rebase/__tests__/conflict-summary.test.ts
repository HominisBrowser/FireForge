// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { buildRebaseConflictSummary } from '../conflict-summary.js';

describe('buildRebaseConflictSummary', () => {
  it('classifies customElements.js failures as registration context drift', () => {
    const summary = buildRebaseConflictSummary({
      patchFilename: '001-ui.patch',
      error: 'error: patch failed: toolkit/content/customElements.js:12',
    });

    expect(summary.category).toBe('registration context drift');
    expect(summary.failedFiles).toEqual(['toolkit/content/customElements.js']);
  });

  it('classifies manifest surfaces as manifest context drift', () => {
    const summary = buildRebaseConflictSummary({
      patchFilename: '001-ui.patch',
      rejectFiles: ['browser/base/jar.mn.rej', 'browser/base/content/test/foo/browser.toml.rej'],
    });

    expect(summary.category).toBe('manifest context drift');
    expect(summary.failedFiles).toEqual([
      'browser/base/content/test/foo/browser.toml',
      'browser/base/jar.mn',
    ]);
  });

  it('falls back to generic patch context drift', () => {
    const summary = buildRebaseConflictSummary({
      patchFilename: '001-ui.patch',
      error: 'error: patch failed: browser/base/content/browser.js:7',
    });

    expect(summary.category).toBe('patch context drift');
  });
});
