// SPDX-License-Identifier: EUPL-1.2
/**
 * Property-based round-trip for the shared diff walker: generate small
 * unified diffs whose file names carry spaces, non-ASCII characters and
 * git's C-style quoting, optionally saved with CRLF line endings, and
 * assert `parseDiffSections` recovers every section, its paths, its
 * new-file marker and its hunk count.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseDiffGitHeader, parseDiffSections } from '../patch-parse.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** One path segment: ASCII word characters, a space, or a non-ASCII run. */
const pathSegment = fc
  .array(
    fc.oneof(
      { weight: 6, arbitrary: fc.stringMatching(/^[a-z0-9_.-]$/) },
      { weight: 1, arbitrary: fc.constant(' ') },
      { weight: 1, arbitrary: fc.constantFrom('ä', 'ß', 'é', '日', '本', 'ø', '€') }
    ),
    { minLength: 1, maxLength: 8 }
  )
  .map((chars) => chars.join(''))
  // git never emits a segment that is only whitespace, and a trailing space
  // in the last segment collides with the `a/x b/x` separator.
  .filter((segment) => segment.trim() === segment && segment !== '.' && segment !== '..');

/** A relative path of one to three segments. */
const filePath = fc
  .array(pathSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'));

/** A hunk: one to four payload lines of context, additions and removals. */
const hunk = fc.array(
  fc
    .tuple(fc.constantFrom(' ', '+', '-'), fc.stringMatching(/^[a-z ]{0,12}$/))
    .map(([marker, text]) => `${marker}${text}`),
  { minLength: 1, maxLength: 4 }
);

interface GeneratedSection {
  path: string;
  isNewFile: boolean;
  quoted: boolean;
  hunks: string[][];
}

const section: fc.Arbitrary<GeneratedSection> = fc.record({
  path: filePath,
  isNewFile: fc.boolean(),
  quoted: fc.boolean(),
  hunks: fc.array(hunk, { minLength: 0, maxLength: 2 }),
});

// ---------------------------------------------------------------------------
// Rendering — mirrors git's own output shapes
// ---------------------------------------------------------------------------

/**
 * git's C-style quoting under `core.quotePath=true`: every byte outside
 * printable ASCII becomes a three-digit octal escape.
 */
function quoteGitPath(path: string): string {
  let out = '';
  for (const byte of Buffer.from(path, 'utf-8')) {
    out +=
      byte < 0x20 || byte >= 0x7f
        ? `\\${byte.toString(8).padStart(3, '0')}`
        : String.fromCharCode(byte);
  }
  return `"${out}"`;
}

function renderHeader(path: string, quoted: boolean): string {
  return quoted
    ? `diff --git ${quoteGitPath(`a/${path}`)} ${quoteGitPath(`b/${path}`)}`
    : `diff --git a/${path} b/${path}`;
}

function renderSection(generated: GeneratedSection): string[] {
  const lines = [renderHeader(generated.path, generated.quoted)];
  if (generated.isNewFile) lines.push('new file mode 100644');
  lines.push('index 0000000..1111111 100644');
  lines.push(`--- ${generated.isNewFile ? '/dev/null' : `a/${generated.path}`}`);
  lines.push(`+++ b/${generated.path}`);
  for (const payload of generated.hunks) {
    lines.push(`@@ -1,${payload.length} +1,${payload.length} @@`);
    lines.push(...payload);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: parseDiffSections round-trips generated diffs', () => {
  it('recovers section count, paths, new-file markers and hunk counts', () => {
    fc.assert(
      fc.property(
        fc.array(section, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('\n', '\r\n'),
        (sections, eol) => {
          const diff = sections.flatMap(renderSection).join(eol) + eol;
          const parsed = parseDiffSections(diff);

          expect(parsed).toHaveLength(sections.length);
          parsed.forEach((got, index) => {
            const want = sections[index];
            if (want === undefined) throw new Error('unreachable: parsed longer than input');
            expect(got.targetPath).toBe(want.path);
            expect(got.sourcePath).toBe(want.path);
            expect(got.isNewFile).toBe(want.isNewFile);
            expect(got.isBinary).toBe(false);
            expect(got.hunks).toHaveLength(want.hunks.length);
            got.hunks.forEach((gotHunk, hunkIndex) => {
              // CRLF-saved patch files have the `\r` stripped from every
              // payload line; an LF file keeps them byte-for-byte.
              expect(gotHunk.lines).toEqual(want.hunks[hunkIndex]);
            });
          });
        }
      )
    );
  });

  it('parses the same paths from the quoted and unquoted header forms', () => {
    fc.assert(
      fc.property(filePath, (path) => {
        const plain = parseDiffGitHeader(renderHeader(path, false));
        const quoted = parseDiffGitHeader(renderHeader(path, true));
        expect(plain).toEqual({ sourcePath: path, targetPath: path });
        expect(quoted).toEqual(plain);
      })
    );
  });

  it('splits a rename header at the first ` b/` when the paths differ', () => {
    // Renames are the asymmetric form; the source side cannot contain ` b/`
    // itself (git would quote it), so generate space-free paths here.
    const spaceless = filePath.filter((path) => !path.includes(' '));
    fc.assert(
      fc.property(spaceless, spaceless, (source, target) => {
        fc.pre(source !== target);
        expect(parseDiffGitHeader(`diff --git a/${source} b/${target}`)).toEqual({
          sourcePath: source,
          targetPath: target,
        });
      })
    );
  });

  it('never throws on arbitrary text and yields sections only at diff --git lines', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((s) => !s.includes('\r')),
        (text) => {
          const parsed = parseDiffSections(text);
          const headerLines = text
            .split('\n')
            .filter((line) => parseDiffGitHeader(line) !== null).length;
          expect(parsed).toHaveLength(headerLines);
        }
      )
    );
  });
});
