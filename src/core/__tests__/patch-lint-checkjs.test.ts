// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCheckJs } from '../patch-lint-checkjs.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

import { pathExists, readText } from '../../utils/fs.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runCheckJs', () => {
  it('returns empty when no files are provided', async () => {
    const issues = await runCheckJs('/engine', new Set());
    expect(issues).toHaveLength(0);
  });

  it('returns empty when owned files do not exist on disk', async () => {
    mockPathExists.mockResolvedValue(false);
    const issues = await runCheckJs('/engine', new Set(['missing/Module.sys.mjs']));
    expect(issues).toHaveLength(0);
  });

  it('detects type errors in patch-owned files', async () => {
    // This test exercises the real TypeScript compiler. It creates a
    // temporary file with an intentional type error and verifies that
    // runCheckJs reports it.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-'));
    const filePath = join(tmpDir, 'Bad.sys.mjs');
    await writeFile(
      filePath,
      ['/** @type {number} */', 'export const value = "not a number";', ''].join('\n')
    );

    // Restore real pathExists for the temp file
    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['Bad.sys.mjs']));
      // TypeScript should flag the type mismatch
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(issues.some((i) => i.check === 'checkjs-type-error')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not flag implicit-any parameters when strict mode is off', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-loose-'));
    const filePath = join(tmpDir, 'Loose.sys.mjs');
    await writeFile(filePath, 'export function f(x) {\n  return x;\n}\n');

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['Loose.sys.mjs']));
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('flags implicit-any parameters when strict mode is on', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-strict-'));
    const filePath = join(tmpDir, 'Strict.sys.mjs');
    await writeFile(filePath, 'export function f(x) {\n  return x;\n}\n');

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['Strict.sys.mjs']), undefined, undefined, {
        strict: true,
      });
      expect(issues.some((i) => i.check === 'checkjs-type-error')).toBe(true);
      expect(
        issues.some(
          (i) =>
            /implicitly has an 'any' type/i.test(i.message) ||
            /Parameter 'x' implicitly/i.test(i.message)
        )
      ).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honours patchLint.checkJsExtraShim by appending it to the built-in shim', async () => {
    // The fixture declares `MozHTMLElement`. Without the extra shim, a
    // file referencing it should produce no diagnostic about the symbol
    // (suppressed by code 2304) — but the type relationship `extends
    // MozHTMLElement` is checked. We assert the reverse: a file that
    // *misuses* a symbol declared only in extraShim still gets typed.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpProject = await mkdtemp(join(tmpdir(), 'ff-checkjs-shim-'));
    const tmpEngine = join(tmpProject, 'engine');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(tmpEngine);
    const filePath = join(tmpEngine, 'Use.sys.mjs');
    await writeFile(
      filePath,
      [
        '/** @returns {number} */',
        'export function badNumber() {',
        '  /** @type {string} */',
        '  const s = customGreeting();',
        '  return s;', // type-mismatch: string returned where number declared
        '}',
        '',
      ].join('\n')
    );
    const shimPath = join(tmpProject, 'extra.d.ts');
    await writeFile(shimPath, 'declare function customGreeting(): string;\n');

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });
    mockReadText.mockImplementation(async (p) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(p, 'utf8');
    });

    try {
      const issues = await runCheckJs(
        tmpEngine,
        new Set(['Use.sys.mjs']),
        'extra.d.ts',
        tmpProject
      );
      expect(issues.length).toBeGreaterThanOrEqual(1);
      // The diagnostic must NOT be a "Cannot find name 'customGreeting'"
      // (those codes are suppressed) — it must be the actual type
      // mismatch on the return statement.
      expect(
        issues.some((i) => /Type 'string' is not assignable to type 'number'/.test(i.message))
      ).toBe(true);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });

  it('returns a clear error when the extra shim file is missing', async () => {
    const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpProject = await mkdtemp(join(tmpdir(), 'ff-checkjs-missing-'));
    const tmpEngine = join(tmpProject, 'engine');
    await mkdir(tmpEngine);
    await writeFile(join(tmpEngine, 'Trivial.sys.mjs'), 'export const x = 1;\n');

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpEngine,
        new Set(['Trivial.sys.mjs']),
        'does-not-exist.d.ts',
        tmpProject
      );
      expect(issues).toHaveLength(1);
      const [issue] = issues;
      if (!issue) throw new Error('expected one issue');
      expect(issue.check).toBe('checkjs-type-error');
      expect(issue.message).toMatch(/Extra TypeScript shim not found/);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });
});
