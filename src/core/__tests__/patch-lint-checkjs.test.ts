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

  it('does not flag dynamic import("resource:-…") or chrome:// namespaces under strict checkJs', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-url-'));
    const filePath = join(tmpDir, 'LazyImports.sys.mjs');
    await writeFile(
      filePath,
      [
        '/**',
        ' * @returns {Promise<unknown>}',
        ' */',
        'export async function loadFromFirefoxUrls() {',
        "  const r = await import('resource:///modules/Fake.sys.mjs');",
        '  await r.persistValue?.(r.getKey?.());',
        "  const c = await import('chrome://browser/content/Fake.sys.mjs');",
        '  await c.maybeInit?.({ foo: true });',
        '  return undefined;',
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['LazyImports.sys.mjs']),
        undefined,
        undefined,
        {
          strict: true,
        }
      );
      const checkJsErrors = issues.filter((i) => i.check === 'checkjs-type-error');
      expect(
        checkJsErrors.filter(
          (i) => /\bunknown\b/i.test(i.message) || /\(\s*"resource:\/\/?\/?"/.test(i.message)
        )
      ).toHaveLength(0);
      expect(checkJsErrors).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('carries JSDoc type-guard predicates across owned chrome:// module boundaries', async () => {
    // Field report B1: per-patch lint used to type all cross-module imports
    // as `any` (noResolve + wildcard ambient modules), so `value is Element`
    // guards lost their narrowing and call sites accumulated false
    // checkjs-type-errors. Owned imports now resolve to real sources.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-guard-'));
    await writeFile(
      join(tmpDir, 'guards.sys.mjs'),
      [
        '/**',
        ' * @param {unknown} value - Candidate value',
        ' * @returns {value is HTMLElement} Whether value is an HTMLElement',
        ' */',
        'export function isHtmlElement(value) {',
        "  return typeof value === 'object' && value !== null && 'tagName' in value;",
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { isHtmlElement } from 'chrome://browser/content/guards.sys.mjs';",
        '/**',
        ' * @param {unknown} node - Candidate node',
        ' * @returns {string}',
        ' */',
        'export function describe(node) {',
        '  if (isHtmlElement(node)) {',
        '    return node.tagName;',
        '  }',
        "  return 'not-an-element';",
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['guards.sys.mjs', 'consumer.sys.mjs']),
        undefined,
        undefined,
        { strict: true }
      );
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports real type errors across owned module boundaries (types actually flow)', async () => {
    // Negative control for the resolver: without narrowing, accessing
    // .tagName on unknown must fail — proving the import is typed from the
    // real source rather than silently any.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-guard-neg-'));
    await writeFile(
      join(tmpDir, 'guards.sys.mjs'),
      [
        '/**',
        ' * @param {unknown} value - Candidate value',
        ' * @returns {value is HTMLElement} Whether value is an HTMLElement',
        ' */',
        'export function isHtmlElement(value) {',
        "  return typeof value === 'object' && value !== null && 'tagName' in value;",
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { isHtmlElement } from 'chrome://browser/content/guards.sys.mjs';",
        '/**',
        ' * @param {unknown} node - Candidate node',
        ' * @returns {string}',
        ' */',
        'export function describe(node) {',
        '  if (!isHtmlElement(node)) {',
        '    return node.tagName;',
        '  }',
        '  return node.tagName;',
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['guards.sys.mjs', 'consumer.sys.mjs']),
        undefined,
        undefined,
        { strict: true }
      );
      const errors = issues.filter((i) => i.check === 'checkjs-type-error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((i) => i.file === 'consumer.sys.mjs')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('carries @template generic inference across owned module boundaries', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-template-'));
    await writeFile(
      join(tmpDir, 'helpers.sys.mjs'),
      [
        '/**',
        ' * @template TItem',
        ' * @param {TItem[]} items - Source array',
        ' * @returns {TItem} The first item',
        ' */',
        'export function first(items) {',
        '  if (items.length === 0) {',
        "    throw new Error('empty');",
        '  }',
        '  return /** @type {TItem} */ (items[0]);',
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { first } from 'resource:///modules/helpers.sys.mjs';",
        '/**',
        ' * @returns {number} Inferred misuse — actually a string',
        ' */',
        'export function misuse() {',
        "  return first(['a', 'b']);",
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['helpers.sys.mjs', 'consumer.sys.mjs']),
        undefined,
        undefined,
        { strict: true }
      );
      const errors = issues.filter((i) => i.check === 'checkjs-type-error');
      // Inference resolves TItem to string, so returning it as number errors.
      expect(errors.some((i) => i.file === 'consumer.sys.mjs')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves ambiguous basenames unresolved (loose wildcard typing, no error)', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-ambig-'));
    await mkdir(join(tmpDir, 'a'), { recursive: true });
    await mkdir(join(tmpDir, 'b'), { recursive: true });
    const utilBody = [
      '/**',
      ' * @returns {number}',
      ' */',
      'export function util() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    await writeFile(join(tmpDir, 'a', 'util.sys.mjs'), utilBody);
    await writeFile(join(tmpDir, 'b', 'util.sys.mjs'), utilBody);
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { util } from 'chrome://browser/content/util.sys.mjs';",
        '/**',
        ' * @returns {unknown}',
        ' */',
        'export function use() {',
        '  return util();',
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['a/util.sys.mjs', 'b/util.sys.mjs', 'consumer.sys.mjs']),
        undefined,
        undefined,
        { strict: true }
      );
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves a plain .mjs specifier to an owned .sys.mjs source', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-mjs-'));
    await writeFile(
      join(tmpDir, 'widget-helper.sys.mjs'),
      [
        '/**',
        ' * @param {unknown} value - Candidate',
        ' * @returns {value is HTMLElement} Guard result',
        ' */',
        'export function isWidget(value) {',
        "  return typeof value === 'object' && value !== null;",
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { isWidget } from 'chrome://global/content/elements/widget-helper.mjs';",
        '/**',
        ' * @param {unknown} node - Candidate',
        ' * @returns {string}',
        ' */',
        'export function describe(node) {',
        "  return isWidget(node) ? node.tagName : 'no';",
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['widget-helper.sys.mjs', 'consumer.sys.mjs']),
        undefined,
        undefined,
        { strict: true }
      );
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts ChromeUtils.getClassName, defineLazyGetter, and Localization under strict checkJs', async () => {
    // Field report B3: these are stable chrome globals; the shim's closed
    // ChromeUtils member list rejected the two methods (TS2339 is not in
    // the suppressed-code set) and Localization was undeclared.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-globals-'));
    const filePath = join(tmpDir, 'ChromeGlobals.sys.mjs');
    await writeFile(
      filePath,
      [
        'const lazyLocal = {};',
        "ChromeUtils.defineLazyGetter(lazyLocal, 'l10n', () => {",
        "  return new Localization(['browser/foo.ftl'], true);",
        '});',
        '/**',
        ' * @param {object} obj - Inspected object',
        ' * @returns {string}',
        ' */',
        'export function classify(obj) {',
        '  return ChromeUtils.getClassName(obj, true);',
        '}',
        '/**',
        ' * @returns {Promise<unknown>}',
        ' */',
        'export async function localize() {',
        "  const l10n = new Localization(['browser/foo.ftl']);",
        "  return l10n.formatValue('some-id', { count: 1 });",
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(
        tmpDir,
        new Set(['ChromeGlobals.sys.mjs']),
        undefined,
        undefined,
        { strict: true }
      );
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
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
