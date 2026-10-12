// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchesManifest, PatchLintIssue } from '../../types/commands/index.js';
import { formatForwardImportRemedy } from '../forward-import-remedy.js';

const MANIFEST: PatchesManifest = {
  version: 1,
  patches: [1, 2].map((order) => ({
    filename: `00${order}-ui-p${order}.patch`,
    order,
    category: 'ui',
    name: `p${order}`,
    description: '',
    createdAt: '',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
  })),
};

const ISSUE: PatchLintIssue = {
  file: 'a/Test.js',
  check: 'forward-import',
  message: 'm',
  severity: 'error',
  stagedDeclarations: [
    {
      patch: '001-ui-p1.patch',
      kind: 'import',
      file: 'a/Test.js',
      specifier: 'resource:///modules/X.sys.mjs',
      creates: 'a/X.sys.mjs',
      owner: '002-ui-p2.patch',
    },
  ],
};

describe('formatForwardImportRemedy', () => {
  it('names the earliest legal order and one command per distinct declaration', () => {
    const text = formatForwardImportRemedy({
      reRunHint: 're-running the scan',
      issues: [ISSUE, ISSUE],
      manifest: MANIFEST,
      category: 'ui',
    });
    expect(text).toContain('"fireforge export <files> --order 003"; 003 is the earliest legal');
    expect(text.split('\n').filter((line) => line.startsWith('  fireforge'))).toHaveLength(1);
  });

  it('renders registration declarations with --kind and --line', () => {
    const text = formatForwardImportRemedy({
      reRunHint: 'x',
      issues: [
        {
          ...ISSUE,
          stagedDeclarations: [
            {
              patch: '001-ui-p1.patch',
              kind: 'registration',
              file: 'a/jar.mn',
              line: 'content/x.js "q"',
              creates: 'a/x.js',
              owner: '002-ui-p2.patch',
            },
          ],
        },
      ],
      manifest: MANIFEST,
    });
    expect(text).toContain('--kind registration --line "content/x.js \\"q\\""');
    // No category: no order is named.
    expect(text).toContain('"fireforge export --order <n>"');
  });

  it('falls back to the generic sentence without structured declarations', () => {
    const bare: PatchLintIssue = { ...ISSUE };
    delete bare.stagedDeclarations;
    const text = formatForwardImportRemedy({
      reRunHint: 're-running the re-export',
      issues: [bare],
      manifest: null,
    });
    expect(text).toBe(
      'Export those files as their own later patch ("fireforge export --order <n>"; or ' +
        '"fireforge patch split --order <n>"), or declare the intentional dependency with ' +
        '"fireforge patch staged-dependency --add" before re-running the re-export.'
    );
  });
});
