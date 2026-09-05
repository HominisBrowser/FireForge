// SPDX-License-Identifier: EUPL-1.2
/**
 * Regression tests for the tokens-CSS scanners' worst-case running time.
 *
 * The category, dark-mode and variant scanners each carried a regex whose
 * backtracking was super-linear in the length of a single line (CodeQL
 * `js/polynomial-redos`, alerts 1-6). The input is not adversarial in the
 * usual sense. `tokens.css` and `docs/design/SRC_TOKENS.md` are files
 * FireForge reads out of a consumer's engine tree, so a line that happens to
 * repeat `:root`, `var(` or `/*=` is enough to wedge `token add` with no
 * attacker anywhere. Each case below is a witness that hangs the old
 * implementation for seconds at these sizes and returns instantly now.
 *
 * The assertions are about growth, not absolute time: each witness is run at
 * a size N and at 16N (after a warm-up, best of several repetitions) and the
 * ratio of the two timings must stay nearer the linear 16x than the
 * quadratic 256x. Absolute budgets were the previous shape and flaked on
 * loaded CI boxes for reasons unrelated to the scanners. Every call here
 * returns the same answer before and after the fix, and the paired
 * behaviour tests pin that answer.
 *
 * The separation is 16x rather than 4x because 4x put the linear and
 * quadratic outcomes only ~2.5x apart, and a constant-factor effect that
 * has nothing to do with the algorithm — cache residency, a scavenge landing
 * in the larger run — can cover that on its own. A node 24 runner measured
 * `time(4N)/time(N) = 10.6` against a threshold of 10 on a scan that is
 * linear. At 16x the same effect is nowhere near the 64x threshold.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findCategorySection } from '../token-category.js';
import { findDarkRootInsertionIndex } from '../token-dark-mode.js';
import { addTokenToDocs } from '../token-docs.js';
import { validateVariantSelector, variantBlockExists } from '../token-variant.js';

/**
 * How much larger the second input is than the first.
 */
const SIZE_FACTOR = 16;

/**
 * Upper bound on time(16N) / time(N). Linear growth sits at ~16, quadratic
 * at ~256. Four times the linear figure leaves generous room for scheduler
 * noise and memory-hierarchy effects without coming close to admitting the
 * old implementations.
 */
const MAX_GROWTH_RATIO = 64;

/**
 * Below this, the large run finished so fast that the ratio is timer noise
 * rather than algorithmic growth, so treat it as trivially linear. A quadratic
 * scan at these sizes cost seconds, not single-digit milliseconds.
 */
const NOISE_FLOOR_MS = 5;

const BASE_N = 10_000;

function bestOfMs(run: () => void, reps = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < reps; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * Times `run` on inputs of size N and {@link SIZE_FACTOR}N (inputs are built
 * outside the timed region) and asserts the growth is linear-ish. `run` must return the same
 * shape at either size. Behaviour is pinned separately.
 */
function expectLinearGrowth<T>(build: (n: number) => T, run: (input: T) => void): void {
  const small = build(BASE_N);
  const large = build(BASE_N * SIZE_FACTOR);
  // Warm-up: JIT and regex compilation must not land on the small run.
  run(small);
  run(large);
  const smallMs = bestOfMs(() => {
    run(small);
  });
  const largeMs = bestOfMs(() => {
    run(large);
  });
  if (largeMs < NOISE_FLOOR_MS) return;
  const ratio = largeMs / smallMs;
  expect(
    ratio,
    `time(${SIZE_FACTOR}N)=${largeMs.toFixed(2)}ms / time(N)=${smallMs.toFixed(2)}ms`
  ).toBeLessThan(MAX_GROWTH_RATIO);
}

describe('findCategorySection scans pathological banner lines in linear time', () => {
  it('does not backtrack over an unterminated banner while listing categories', () => {
    // Old: /\/\*\s*=+\s*(.+?)\s*=+\s*\*\// in discoverCategoryHeaders.
    // `=+` and the lazy `(.+?)` both match `=`, so the run is re-partitioned
    // once per length. 4 000 `=` took ~8 s.
    expectLinearGrowth(
      (n) => ['/*' + '='.repeat(n)],
      (lines) => {
        expect(() => findCategorySection(lines, 'Missing', 'tokens.css')).toThrow(
          /Category "Missing" not found/
        );
      }
    );
  });

  it('does not backtrack over a repeated comment opener while bounding a section', () => {
    // Old: /\/\*\s*=.*=\s*\*\// in the section-end scan. `.` matches `=`, and
    // the unanchored `/*` restarts the whole attempt at every occurrence.
    // The leading `x` keeps the line out of the header-skip loop above it, so
    // the section-end scan is the code under test.
    expectLinearGrowth(
      (n) => ['/* = Colors = */', '  --a: red;', 'x' + '/*='.repeat(n)],
      (lines) => {
        expect(findCategorySection(lines, 'Colors', 'tokens.css')).toEqual({
          categoryLine: 0,
          sectionEnd: 3,
        });
      }
    );
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
    // Old: /(^|[\s,{])\s*:root\b/. Both `[\s,{]` and `\s*` match a tab, so
    // every split of the run is tried at every start offset.
    expectLinearGrowth(
      (n) => ['@media (prefers-color-scheme: dark) {', '\t'.repeat(n), '}'],
      (lines) => {
        findDarkRootInsertionIndex(lines);
      }
    );
  });

  it('does not restart the brace search at every :root occurrence', () => {
    // Old: /:root[^{}]*\{/. Unambiguous internally, but the unanchored
    // `:root` prefix makes the scan quadratic on a line repeating it.
    expectLinearGrowth(
      (n) => ['@media (prefers-color-scheme: dark) {', ':root'.repeat(n), '}'],
      (lines) => {
        findDarkRootInsertionIndex(lines);
      }
    );
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
    // Old: /:root\[[^{]*\]/. Here `[^{]` also matches `]`, so the closing bracket
    // is searched for at every partition, from every `:root[` in the line.
    expectLinearGrowth(
      (n) => [':root['.repeat(n)],
      (lines) => {
        expect(variantBlockExists(lines, '[data-skin="precision"]')).toBe(false);
      }
    );
  });

  it('still matches a variant block across quoting styles', () => {
    const lines = [':root[data-skin=precision] {', '  --a: red;', '}'];
    expect(variantBlockExists(lines, '[data-skin="precision"]')).toBe(true);
    expect(variantBlockExists(lines, '[data-skin="calm"]')).toBe(false);
  });

  it('validates a pathological --variant value in linear time too', () => {
    // The validator runs the same parse as the matcher (that is what it is
    // for), so it inherits the matcher's linearity. The per-group identifier
    // check is applied one bracket group at a time rather than as a repeated
    // pattern, which is the shape that backtracks.
    expectLinearGrowth(
      (n) => '[data-a'.repeat(n),
      (value) => {
        expect(validateVariantSelector(value).ok).toBe(false);
      }
    );
  });

  it('still reads a multi-attribute selector as the whole fragment', () => {
    // The scanner spans to the last `]` before the brace, so a two-attribute
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
    // Old: value.replace(/var\(([^)]+)\)/, '$1'). Unanchored, so the match is
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
