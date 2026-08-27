// SPDX-License-Identifier: EUPL-1.2
/**
 * Regression tests for the tokens-CSS scanners' worst-case running time.
 *
 * The category, dark-mode and variant scanners each carried a regex whose
 * backtracking was super-linear in the length of a single line (CodeQL
 * `js/polynomial-redos`, alerts 1-6). The input is not adversarial in the
 * usual sense — `tokens.css` and `docs/design/SRC_TOKENS.md` are files
 * FireForge reads out of a CONSUMER's engine tree — so a line that happens to
 * repeat `:root`, `var(` or `/*=` is enough to wedge `token add` with no
 * attacker anywhere. Each case below is a witness that hangs the old
 * implementation for seconds at these sizes and returns instantly now.
 *
 * The assertions are deliberately wall-clock: the defect is a running time,
 * not an output, and every one of these calls returns the SAME answer before
 * and after the fix. The paired behaviour tests pin that answer.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findCategorySection } from '../token-category.js';
import { findDarkRootInsertionIndex } from '../token-dark-mode.js';
import { addTokenToDocs } from '../token-docs.js';
import { variantBlockExists } from '../token-variant.js';

/**
 * Generous enough that a loaded CI box never flakes, and still well under the
 * 0.8-8 s each witness below cost the old implementations at these sizes.
 */
const BUDGET_MS = 200;

function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('findCategorySection scans pathological banner lines in linear time', () => {
  it('does not backtrack over an unterminated banner while listing categories', () => {
    // Old: /\/\*\s*=+\s*(.+?)\s*=+\s*\*\// in discoverCategoryHeaders.
    // `=+` and the lazy `(.+?)` both match `=`, so the run is re-partitioned
    // once per length. 4 000 `=` took ~8 s.
    const lines = ['/*' + '='.repeat(4000)];

    const ms = elapsed(() => {
      expect(() => findCategorySection(lines, 'Missing', 'tokens.css')).toThrow(
        /Category "Missing" not found/
      );
    });

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('does not backtrack over a repeated comment opener while bounding a section', () => {
    // Old: /\/\*\s*=.*=\s*\*\// in the section-end scan. `.` matches `=`, and
    // the unanchored `/*` restarts the whole attempt at every occurrence.
    // The leading `x` keeps the line out of the header-skip loop above it, so
    // the section-end scan is the code under test.
    const lines = ['/* = Colors = */', '  --a: red;', 'x' + '/*='.repeat(40000)];

    let section: { categoryLine: number; sectionEnd: number } | undefined;
    const ms = elapsed(() => {
      section = findCategorySection(lines, 'Colors', 'tokens.css');
    });

    expect(section).toEqual({ categoryLine: 0, sectionEnd: 3 });
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still bounds a section at the next banner, blank name or not', () => {
    const lines = [
      '/* = Colors = */',
      '  --a: red;',
      '/* ===================== */',
      '  --b: blue;',
    ];
    expect(findCategorySection(lines, 'Colors', 'tokens.css')).toEqual({
      categoryLine: 0,
      sectionEnd: 2,
    });
  });

  it('still reports the categories it discovered, in document order', () => {
    const lines = [
      ':root {',
      '  /* = Colors = */',
      '  --a: red;',
      '  /* =========',
      '   * Spacing',
      '   * ========= */',
      '  --b: 1px;',
      '}',
    ];
    expect(() => findCategorySection(lines, 'Missing', 'tokens.css')).toThrow(
      /Available categories in the file: "Colors", "Spacing"\./
    );
  });
});

describe('findDarkRootInsertionIndex scans pathological selector lines in linear time', () => {
  it('does not backtrack over a run of leading whitespace', () => {
    // Old: /(^|[\s,{])\s*:root\b/ — `[\s,{]` and `\s*` both match a tab, so
    // every split of the run is tried at every start offset.
    const lines = ['@media (prefers-color-scheme: dark) {', '\t'.repeat(50000), '}'];

    const ms = elapsed(() => {
      findDarkRootInsertionIndex(lines);
    });

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('does not restart the brace search at every :root occurrence', () => {
    // Old: /:root[^{}]*\{/ — unambiguous internally, but the unanchored
    // `:root` prefix makes the scan quadratic on a line repeating it.
    const lines = ['@media (prefers-color-scheme: dark) {', ':root'.repeat(40000), '}'];

    const ms = elapsed(() => {
      findDarkRootInsertionIndex(lines);
    });

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still finds the nested :root block with the brace on the selector line', () => {
    const lines = [
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --a: black;',
      '  }',
      '}',
    ];
    expect(findDarkRootInsertionIndex(lines)).toBe(3);
  });

  it('still finds the nested :root block with the brace on the next line', () => {
    const lines = [
      '@media (prefers-color-scheme: dark) {',
      '  :root',
      '  {',
      '    --a: black;',
      '  }',
      '}',
    ];
    expect(findDarkRootInsertionIndex(lines)).toBe(4);
  });

  it('still refuses a :root whose line closes a block before it opens one', () => {
    // `}` between the selector and the brace means this `{` is not the
    // `:root` block's opener, so the scanner must not adopt the line.
    const lines = ['@media (prefers-color-scheme: dark) {', '  :root } {', '}'];
    expect(findDarkRootInsertionIndex(lines)).toBe(-1);
  });
});

describe('variantBlockExists scans pathological attribute selectors in linear time', () => {
  it('does not backtrack over a repeated :root[ opener', () => {
    // Old: /:root\[[^{]*\]/ — `[^{]` also matches `]`, so the closing bracket
    // is searched for at every partition, from every `:root[` in the line.
    const lines = [':root['.repeat(40000)];

    const ms = elapsed(() => {
      expect(variantBlockExists(lines, '[data-skin="precision"]')).toBe(false);
    });

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still matches a variant block across quoting styles', () => {
    const lines = [':root[data-skin=precision] {', '  --a: red;', '}'];
    expect(variantBlockExists(lines, '[data-skin="precision"]')).toBe(true);
    expect(variantBlockExists(lines, '[data-skin="calm"]')).toBe(false);
  });

  it('still reads a multi-attribute selector as the whole fragment', () => {
    // The scanner spans to the LAST `]` before the brace, so a two-attribute
    // block does not satisfy a one-attribute variant that is its prefix.
    const lines = [':root[data-skin=precision][data-private] {', '  --a: red;', '}'];
    expect(variantBlockExists(lines, '[data-skin=precision]')).toBe(false);
    expect(variantBlockExists(lines, '[data-skin=precision][data-private]')).toBe(true);
  });
});

describe('addTokenToDocs maps a var() value without rescanning every var( occurrence', () => {
  let projectDir: string;
  let engineDir: string;
  // `addTokenToDocs` resolves the doc against the engine checkout's PARENT.
  const docPath = 'docs/design/SRC_TOKENS.md';

  const table = [
    '# Tokens',
    '',
    '| Category | Token | Value | Maps to | Mode |',
    '| --- | --- | --- | --- | --- |',
    '| Colors | `--existing` | `red` | — | base |',
    '',
  ].join('\n');

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'fireforge-token-docs-'));
    engineDir = join(projectDir, 'engine');
    await mkdir(engineDir, { recursive: true });
    await mkdir(join(projectDir, 'docs', 'design'), { recursive: true });
    await writeFile(join(projectDir, docPath), table, 'utf8');
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('still records the referenced custom property in the "Maps to" cell', async () => {
    // Old: value.replace(/var\(([^)]+)\)/, '$1') — unanchored, so the match is
    // retried at every `var(`. The value always starts with `var(` on this
    // branch, so anchoring is both linear and exact.
    await addTokenToDocs(
      engineDir,
      { tokenName: '--surface', value: 'var(--base-canvas)', category: 'Colors', mode: 'base' },
      'base'
    );

    const written = await readFile(join(projectDir, docPath), 'utf8');
    expect(written).toContain('`--surface`');
    expect(written).toContain('--base-canvas');
  });
});
