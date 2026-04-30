// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../parser-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parser-fallback.js')>();
  return {
    ...actual,
    withParserFallback: vi.fn(actual.withParserFallback),
  };
});

import { pathExists, readText, writeText } from '../../utils/fs.js';
import { buildEntry, measureSourceColumn, registerSharedCSS } from '../register-shared-css.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const MOCK_JAR_INC_MN = `
  skin/classic/browser/autocomplete.css    (../shared/autocomplete.css)
  skin/classic/browser/browser.css         (../shared/browser.css)
  skin/classic/browser/zoom.css            (../shared/zoom.css)
`.trimStart();

describe('registerSharedCSS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(MOCK_JAR_INC_MN);
    mockWriteText.mockResolvedValue(undefined);
  });

  it('inserts CSS entry in alphabetical order (middle)', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.skipped).toBe(false);
    expect(result.manifest).toBe('browser/themes/shared/jar.inc.mn');
    expect(mockWriteText).toHaveBeenCalled();

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));
    const browserIdx = lines.findIndex((l: string) => l.includes('browser.css'));
    const zoomIdx = lines.findIndex((l: string) => l.includes('zoom.css'));

    expect(customIdx).toBeGreaterThan(browserIdx);
    expect(customIdx).toBeLessThan(zoomIdx);
  });

  it('is idempotent — skips if already registered', async () => {
    const content =
      MOCK_JAR_INC_MN + '  skin/classic/browser/custom.css    (../shared/custom.css)\n';
    mockReadText.mockResolvedValue(content);

    const result = await registerSharedCSS('/engine', 'custom.css');
    expect(result.skipped).toBe(true);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('throws when the manifest is missing', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(registerSharedCSS('/engine', 'custom.css')).rejects.toThrow('Manifest not found');
  });

  it('respects the dryRun flag (no file write)', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css', undefined, true);

    expect(result.skipped).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('strips .css extension from fileName for the entry name', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.entry).toContain('skin/classic/browser/custom.css');
    expect(result.entry).toContain('(../shared/custom.css)');
  });

  it('inserts after a specific target when --after is provided', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css', 'autocomplete.css');

    expect(result.skipped).toBe(false);

    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const autoIdx = lines.findIndex((l: string) => l.includes('autocomplete.css'));
    const customIdx = lines.findIndex((l: string) => l.includes('custom.css'));

    expect(customIdx).toBe(autoIdx + 1);
  });

  it('falls back to alphabetical when --after target is not found', async () => {
    const result = await registerSharedCSS('/engine', 'custom.css', 'nonexistent.css');

    expect(result.skipped).toBe(false);
    expect(result.afterFallback).toBe(true);
  });

  it('aligns the (source) column to match adjacent entries (Finding 3)', async () => {
    // Pre-fix: registerSharedCSS hardcoded a 4-space gap between the
    // target path and the source parenthesis, regardless of the
    // surrounding manifest's alignment. Real Firefox jar.inc.mn files
    // pad to a wider column, so a freshly registered entry landed at
    // the wrong column and produced avoidable formatting churn.
    // The MOCK_JAR_INC_MN fixture aligns every `(` at column 43; the
    // newly inserted line for `custom.css` (target length 33 with the
    // two-space indent) should pad with 10 spaces so its `(` lands at
    // column 43 too.
    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customLine = lines.find((l: string) => l.includes('skin/classic/browser/custom.css'));
    expect(customLine).toBeDefined();
    const parenIdx = (customLine ?? '').indexOf('(../shared/custom.css)');
    expect(parenIdx).toBe(43);
  });

  describe('alignment helpers', () => {
    it('measureSourceColumn returns undefined when the manifest has no skin/classic/browser entries', () => {
      // The defensive fallback in buildEntry's ternary
      // (`sourceColumn !== undefined && sourceColumn >= minColumn`)
      // depends on this case to route to the four-space floor. Pin it
      // here even though `registerSharedCSS` itself can't reach this
      // path (the underlying section lookup throws first).
      expect(measureSourceColumn('# unrelated content\n# more content\n')).toBeUndefined();
    });

    it('measureSourceColumn returns the maximum parenthesis column across sampled entries', () => {
      // Multiple entries with different paren columns must resolve to
      // the maximum so the new entry aligns to the widest existing
      // row, not to an outlier-narrow one. Construct two entries with
      // different padding widths and assert the helper returns the
      // larger column.
      const wideTarget = '  skin/classic/browser/zoom.css';
      const narrowTarget = '  skin/classic/browser/a.css';
      const wideLine = `${wideTarget}    (../shared/zoom.css)`; // gap = 4
      const narrowLine = `${narrowTarget}            (../shared/a.css)`; // gap = 12
      const expectedNarrowParen = narrowTarget.length + 12;
      const measured = measureSourceColumn(`${wideLine}\n${narrowLine}\n`);
      expect(measured).toBe(expectedNarrowParen);
    });

    it('buildEntry uses the four-space floor when sourceColumn is undefined', () => {
      // Reachable directly via the helper; covers the
      // `sourceColumn === undefined` branch of the ternary.
      const entry = buildEntry('foo', undefined);
      const parenIdx = entry.indexOf('(../shared/foo.css)');
      // `  skin/classic/browser/foo.css` = 30 chars, plus 4-space floor
      // → `(` at column 34.
      expect(parenIdx).toBe(34);
    });
  });

  it('preserves a four-space minimum when adjacent entries use a tighter column', async () => {
    // Defensive floor for the alignment heuristic: when adjacent
    // entries already align tighter than the four-space minimum
    // (unlikely in real Firefox checkouts, but possible after a hand
    // edit), the new entry must not collapse to a one- or two-space
    // gap that would smush the source against the target. Construct a
    // manifest whose only existing entry has parens at column 25 — well
    // below the target's column 33 — and assert the inserted entry
    // still leaves the four-space MIN_SOURCE_GAP.
    mockReadText.mockResolvedValue('  skin/classic/browser/a.css (../shared/a.css)\n');
    const result = await registerSharedCSS('/engine', 'custom.css');

    expect(result.skipped).toBe(false);
    const written = mockWriteText.mock.calls[0]?.[1] ?? '';
    const lines = written.split('\n');
    const customLine = lines.find((l: string) => l.includes('skin/classic/browser/custom.css'));
    expect(customLine).toBeDefined();
    // `  skin/classic/browser/custom.css` = 33 chars, then 4-space
    // floor → `(` at column 37.
    const parenIdx = (customLine ?? '').indexOf('(../shared/custom.css)');
    expect(parenIdx).toBe(37);
  });
});
