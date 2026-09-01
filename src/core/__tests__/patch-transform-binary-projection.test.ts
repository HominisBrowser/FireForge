// SPDX-License-Identifier: EUPL-1.2
/**
 * The new-file TEXT projection must skip binary sections.
 *
 * Vendoring a brand-new binary file (a WOFF2 font face, say) was impossible
 * before 0.45.0: every cross-patch-lint projection fed each detected new file
 * to the text extractor, which refuses binary sections by design, so
 * `re-export --scan --scan-file`, `export --order`, `patch move-files-into`
 * and `patch split` all died on a file whose `GIT binary patch` the export
 * half had just written correctly.
 */
import { describe, expect, it } from 'vitest';

import { PatchError } from '../../errors/patch.js';
import { buildNewFileTextProjection, extractNewFileContentFromDiff } from '../patch-transform.js';

const TEXT_SECTION = [
  'diff --git a/browser/themes/shared/hominis/fonts.css b/browser/themes/shared/hominis/fonts.css',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/browser/themes/shared/hominis/fonts.css',
  '@@ -0,0 +1,2 @@',
  '+@font-face { font-family: "Nebula Sans"; }',
  '+/* end */',
].join('\n');

/** A real `git diff --binary` new-file section: base85 payload lines. */
const BINARY_SECTION = [
  'diff --git a/browser/themes/shared/hominis/fonts/nebula-sans-regular.woff2 b/browser/themes/shared/hominis/fonts/nebula-sans-regular.woff2',
  'new file mode 100644',
  'index 0000000000000000000000000000000000000000..1234567890abcdef1234567890abcdef12345678',
  'GIT binary patch',
  'literal 24',
  // Base85 payload. The leading `+` here is exactly why text extraction
  // cannot be applied to these lines.
  'zcmZQzU|<4=Vp3+Ez>vXk+SdU$',
  '',
  'literal 0',
  'HcmV?d00001',
].join('\n');

/** The payload-free informational form. Also binary, also skipped. */
const BINARY_STUB_SECTION = [
  'diff --git a/browser/branding/icon.png b/browser/branding/icon.png',
  'new file mode 100644',
  'index 0000000..1234567',
  'Binary files /dev/null and b/browser/branding/icon.png differ',
].join('\n');

const MIXED_DIFF = `${TEXT_SECTION}\n${BINARY_SECTION}\n${BINARY_STUB_SECTION}\n`;

describe('buildNewFileTextProjection', () => {
  it('projects text new files and skips binary ones', () => {
    const projection = buildNewFileTextProjection(MIXED_DIFF);

    expect([...projection.keys()]).toEqual(['browser/themes/shared/hominis/fonts.css']);
    expect(projection.get('browser/themes/shared/hominis/fonts.css')).toBe(
      '@font-face { font-family: "Nebula Sans"; }\n/* end */\n'
    );
  });

  it('does not throw on a diff whose ONLY new file is binary', () => {
    // The reported blocker: eight WOFF2 faces and nothing else.
    expect(() => buildNewFileTextProjection(`${BINARY_SECTION}\n`)).not.toThrow();
    expect(buildNewFileTextProjection(`${BINARY_SECTION}\n`).size).toBe(0);
  });

  it('never emits base85 payload lines as file content', () => {
    // The corruption this skip exists to prevent: the base85 alphabet
    // includes '+', so a text walker would happily "extract" payload lines.
    for (const content of buildNewFileTextProjection(MIXED_DIFF).values()) {
      expect(content).not.toContain('zcmZQzU');
      expect(content).not.toContain('HcmV?d');
    }
  });

  it('ignores modified (non-new) files, binary or not', () => {
    const modified = [
      'diff --git a/browser/existing.js b/browser/existing.js',
      '--- a/browser/existing.js',
      '+++ b/browser/existing.js',
      '@@ -1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n');

    expect(buildNewFileTextProjection(modified).size).toBe(0);
  });

  it('projects an empty new file as the empty string, not a newline', () => {
    const empty = [
      'diff --git a/browser/empty.js b/browser/empty.js',
      'new file mode 100644',
      'index 0000000..e69de29',
      '',
    ].join('\n');

    expect(buildNewFileTextProjection(empty).get('browser/empty.js')).toBe('');
  });
});

describe('extractNewFileContentFromDiff', () => {
  it('still refuses a binary section named explicitly', () => {
    // The single-file contract is unchanged: a caller that asked for THIS
    // file's text by name must be refused, not silently handed nothing.
    expect(() =>
      extractNewFileContentFromDiff(
        MIXED_DIFF,
        'browser/themes/shared/hominis/fonts/nebula-sans-regular.woff2'
      )
    ).toThrow(PatchError);
  });

  it('extracts a text section from a diff that also carries binary ones', () => {
    expect(
      extractNewFileContentFromDiff(MIXED_DIFF, 'browser/themes/shared/hominis/fonts.css')
    ).toBe('@font-face { font-family: "Nebula Sans"; }\n/* end */\n');
  });
});
