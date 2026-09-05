// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';
import { runCheckJs, runCheckJsGrouped } from '../patch-lint-checkjs.js';

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

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

  it('reports undefined free identifiers as warnings by default', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-undef-'));
    await writeFile(
      join(tmpDir, 'Undef.sys.mjs'),
      // EditorState is undefined. Services is a shim-covered global.
      'export const state = EditorState.create({});\nexport const prefs = Services.prefs;\n'
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['Undef.sys.mjs']));
      const undefIssues = issues.filter((i) => i.message.includes('EditorState'));
      expect(undefIssues).toHaveLength(1);
      expect(undefIssues[0]?.severity).toBe('warning');
      expect(undefIssues[0]?.message).toContain('undefined identifier');
      expect(issues.some((i) => i.message.includes("'Services'"))).toBe(false);

      const asError = await runCheckJs(tmpDir, new Set(['Undef.sys.mjs']), undefined, undefined, {
        strict: false,
        undefinedIdentifiers: 'error',
      });
      expect(asError.find((i) => i.message.includes('EditorState'))?.severity).toBe('error');

      const asOff = await runCheckJs(tmpDir, new Set(['Undef.sys.mjs']), undefined, undefined, {
        strict: false,
        undefinedIdentifiers: 'off',
      });
      expect(asOff.some((i) => i.message.includes('EditorState'))).toBe(false);
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
    // Per-patch lint must not type all cross-module imports
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
    // .tagName on unknown must fail, which shows the import is typed from
    // the real source rather than silently any.
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
    // These are stable chrome globals. The shim's closed
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
    // (suppressed by code 2304), but the type relationship `extends
    // MozHTMLElement` is checked. We assert the reverse: a file that
    // misuses a symbol declared only in extraShim still gets typed.
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
      // The diagnostic must not be a "Cannot find name 'customGreeting'"
      // (those codes are suppressed). It must be the actual type mismatch
      // on the return statement.
      expect(
        issues.some((i) => /Type 'string' is not assignable to type 'number'/.test(i.message))
      ).toBe(true);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });

  it('accepts ChromeUtils.predictRemoteTypeForURI out of the box under strict checkJs', async () => {
    // 152.0b7 → 153.0b8 source-refresh drill: porting consumer code to
    // the Firefox 153 API tripped checkjs-type-error because the shim's
    // ChromeUtils predated the member, while whole-project `fireforge
    // typecheck` (engine tools/@types Gecko types) accepted the call.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-predict-'));
    const filePath = join(tmpDir, 'Predict.sys.mjs');
    await writeFile(
      filePath,
      [
        '/**',
        ' * @param {string} uriString - URI to classify',
        ' * @returns {string | null}',
        ' */',
        'export function predict(uriString) {',
        '  return ChromeUtils.predictRemoteTypeForURI(uriString, { forNewTab: true });',
        '}',
        'export const noOptions = ChromeUtils.predictRemoteTypeForURI(null);',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['Predict.sys.mjs']), undefined, undefined, {
        strict: true,
      });
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('lets an extra shim ADD members to shim globals via interface merging', async () => {
    // `ChromeUtilsShim` is a mergeable global interface, so a project extra
    // shim can extend `ChromeUtils` without the duplicate-identifier error a
    // second `declare var ChromeUtils` produces. The fixture adds a novel
    // member. The correct use must pass (proving no duplicate-identifier /
    // missing-member diagnostics) and a misuse must still be flagged
    // (proving the member is TYPED by the merge, not swallowed by a
    // suppressed cannot-find-name code).
    const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpProject = await mkdtemp(join(tmpdir(), 'ff-checkjs-merge-'));
    const tmpEngine = join(tmpProject, 'engine');
    await mkdir(tmpEngine);
    await writeFile(
      join(tmpEngine, 'GoodUse.sys.mjs'),
      [
        '/** @returns {number} */',
        'export function ranking() {',
        "  return ChromeUtils.novelRanker('https://example.com/');",
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpEngine, 'BadUse.sys.mjs'),
      [
        '/** @returns {string} */',
        'export function label() {',
        "  return ChromeUtils.novelRanker('https://example.com/');",
        '}',
        '',
      ].join('\n')
    );
    const shimPath = join(tmpProject, 'extra.d.ts');
    await writeFile(
      shimPath,
      ['interface ChromeUtilsShim {', '  novelRanker(uri: string): number;', '}', ''].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });
    mockReadText.mockImplementation(async (p) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(p, 'utf8');
    });

    try {
      const goodIssues = await runCheckJs(
        tmpEngine,
        new Set(['GoodUse.sys.mjs']),
        'extra.d.ts',
        tmpProject
      );
      expect(goodIssues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);

      const badIssues = await runCheckJs(
        tmpEngine,
        new Set(['BadUse.sys.mjs']),
        'extra.d.ts',
        tmpProject
      );
      expect(
        badIssues.some((i) => /Type 'number' is not assignable to type 'string'/.test(i.message))
      ).toBe(true);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });

  it('accepts JSWindowActor globals in the built-in Firefox shim', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-actor-'));
    const filePath = join(tmpDir, 'PageFactsChild.sys.mjs');
    await writeFile(
      filePath,
      [
        'ChromeUtils.registerWindowActor("PageFacts", {',
        '  child: { moduleURI: "resource:///actors/PageFactsChild.sys.mjs" },',
        '  parent: { moduleURI: "resource:///actors/PageFactsParent.sys.mjs" },',
        '});',
        'export class PageFactsChild extends JSWindowActorChild {',
        '  handleEvent() {',
        '    this.sendAsyncMessage("PageFacts:Ready", {',
        '      title: this.document?.title,',
        '      context: this.browsingContext,',
        '    });',
        '  }',
        '}',
        'export class PageFactsParent extends JSWindowActorParent {',
        '  receiveMessage() {',
        '    this.sendAsyncMessage("PageFacts:Ack", { context: this.browsingContext });',
        '  }',
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const issues = await runCheckJs(tmpDir, new Set(['PageFactsChild.sys.mjs']));
      expect(issues.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
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

  // Scope split: one program, per-file attribution.

  it('runCheckJsGrouped attributes each diagnostic to its originating file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-grouped-'));
    await writeFile(join(tmpDir, 'good.sys.mjs'), 'export const ok = 1;\n');
    await writeFile(
      join(tmpDir, 'bad.sys.mjs'),
      [
        '/** @returns {number} */',
        'export function f() {',
        "  return 'not a number';",
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const { byFile, global } = await runCheckJsGrouped({
        repoDir: tmpDir,
        resolutionOwned: new Set(['good.sys.mjs', 'bad.sys.mjs']),
      });
      expect(global).toHaveLength(0);
      // The error is attributed to bad.sys.mjs only: not duplicated, and
      // not on good.
      expect(byFile.has('good.sys.mjs')).toBe(false);
      expect(byFile.get('bad.sys.mjs')?.length ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reportScope restricts reported diagnostics while resolution spans every owned file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-scope-'));
    await writeFile(
      join(tmpDir, 'A.sys.mjs'),
      [
        '/**',
        ' * @param {number} n - input',
        ' * @returns {number} doubled',
        ' */',
        'export function dbl(n) {',
        '  return n * 2;',
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'B.sys.mjs'),
      [
        "import { dbl } from 'resource:///modules/A.sys.mjs';",
        '/** @returns {number} The doubled value */',
        'export function use() {',
        "  return dbl('not a number');",
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const owned = new Set(['A.sys.mjs', 'B.sys.mjs']);
      // B misuses A's API. Resolution spans both (no ambient stub needed).
      // Scoping the report to B surfaces the cross-patch type error.
      const reportedForB = await runCheckJs(
        tmpDir,
        owned,
        undefined,
        undefined,
        { strict: true },
        new Set(['B.sys.mjs'])
      );
      const bErrors = reportedForB.filter((i) => i.check === 'checkjs-type-error');
      expect(bErrors.length).toBeGreaterThanOrEqual(1);
      expect(bErrors.every((i) => i.file === 'B.sys.mjs')).toBe(true);

      // Scoping the report to A excludes B's finding, since A itself is
      // clean.
      const reportedForA = await runCheckJs(
        tmpDir,
        owned,
        undefined,
        undefined,
        { strict: true },
        new Set(['A.sys.mjs'])
      );
      expect(reportedForA.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honours a checkJsCompilerOptions paths mapping to type a non-owned module (route 2)', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-paths-'));
    await mkdir(join(tmpDir, 'lib'), { recursive: true });
    await writeFile(
      join(tmpDir, 'lib', 'Api.sys.mjs'),
      [
        '/**',
        ' * @returns {number} a number',
        ' */',
        'export function getNum() {',
        '  return 1;',
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { getNum } from 'resource:///custom/Api.sys.mjs';",
        '/** @returns {string} A string */',
        'export function use() {',
        '  return getNum();',
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const owned = new Set(['consumer.sys.mjs']);
      // Without paths the import is unresolved (any), so no type error
      // surfaces.
      const noPaths = await runCheckJs(tmpDir, owned, undefined, undefined, { strict: true });
      expect(noPaths.filter((i) => i.check === 'checkjs-type-error')).toHaveLength(0);

      // With the paths mapping the import resolves to lib/Api.sys.mjs, so
      // returning a number where a string is declared errors.
      const withPaths = await runCheckJs(tmpDir, owned, undefined, undefined, {
        strict: true,
        compilerOptions: { paths: { 'resource:///custom/*': ['lib/*'] } },
      });
      const errors = withPaths.filter((i) => i.check === 'checkjs-type-error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((i) => i.file === 'consumer.sys.mjs')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honours an exact (wildcard-free) paths mapping, and substitutes only the one wildcard', async () => {
    // The substitution is index arithmetic rather than `replace('*', …)`
    // (CodeQL `js/incomplete-sanitization` read the first-occurrence-only
    // replace as an incomplete rewrite). Both target shapes are pinned here:
    // a wildcard-free target, which is used verbatim, and a target whose one
    // `*` is filled with the captured segment.
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'ff-checkjs-paths-exact-'));
    await mkdir(join(tmpDir, 'lib'), { recursive: true });
    await writeFile(
      join(tmpDir, 'lib', 'Exact.sys.mjs'),
      [
        '/**',
        ' * @returns {number} a number',
        ' */',
        'export function getNum() {',
        '  return 1;',
        '}',
        '',
      ].join('\n')
    );
    await writeFile(
      join(tmpDir, 'consumer.sys.mjs'),
      [
        "import { getNum } from 'resource:///exact/Thing.sys.mjs';",
        '/** @returns {string} A string */',
        'export function use() {',
        '  return getNum();',
        '}',
        '',
      ].join('\n')
    );

    mockPathExists.mockImplementation(async (p) => {
      const { existsSync } = await import('node:fs');
      return existsSync(p);
    });

    try {
      const owned = new Set(['consumer.sys.mjs']);
      const result = await runCheckJs(tmpDir, owned, undefined, undefined, {
        strict: true,
        compilerOptions: {
          paths: { 'resource:///exact/Thing.sys.mjs': ['lib/Exact.sys.mjs'] },
        },
      });
      const errors = result.filter((i) => i.check === 'checkjs-type-error');
      expect(errors.some((i) => i.file === 'consumer.sys.mjs')).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honours a triple-slash <reference> inside the extra shim instead of dropping it', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpProject = await mkdtemp(join(tmpdir(), 'ff-checkjs-tripleslash-'));
    const tmpEngine = join(tmpProject, 'engine');
    await mkdir(join(tmpProject, 'refs'), { recursive: true });
    await mkdir(tmpEngine, { recursive: true });
    // The symbol lives in a referenced file, pulled in only if the
    // triple-slash directive is honoured.
    await writeFile(
      join(tmpProject, 'refs', 'customGreeting.d.ts'),
      'declare function customGreeting(): string;\n'
    );
    await writeFile(
      join(tmpProject, 'extra.d.ts'),
      '/// <reference path="./refs/customGreeting.d.ts" />\n'
    );
    await writeFile(
      join(tmpEngine, 'Use.sys.mjs'),
      [
        '/** @returns {number} A number */',
        'export function badNumber() {',
        '  /** @type {string} */',
        '  const s = customGreeting();',
        '  return s;',
        '}',
        '',
      ].join('\n')
    );

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
      // The referenced declaration was inlined, so `customGreeting()` is typed
      // as string and the number-return mismatch is detected (rather than the
      // symbol being unknown and suppressed).
      expect(
        issues.some((i) => /Type 'string' is not assignable to type 'number'/.test(i.message))
      ).toBe(true);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });
});
