// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared TypeScript-checking constants used by both the patch-lint
 * `checkJs` pass (`patch-lint-checkjs.ts`) and the whole-project
 * `fireforge typecheck` command (`typecheck.ts`).
 *
 * Centralised so both flows agree on the same Firefox-globals shim
 * and the same set of suppressed diagnostic codes — drift between the
 * two would mean a patch could lint clean under `fireforge lint` but
 * still fail `fireforge typecheck`, or vice versa, for reasons the
 * operator could not infer from the rule names.
 */

import { dirname, resolve } from 'node:path';

import { pathExists, readText } from '../utils/fs.js';

/** Filename used for the synthetic Firefox-globals shim source file. */
export const SHIM_FILENAME = '__fireforge_firefox_globals.d.ts';

/**
 * Minimal `.d.ts` shim for Firefox privileged-scope globals.
 *
 * Firefox source is plain JS — no TypeScript allowed. The shim lets
 * TS-driven type checking run without reporting "cannot find name"
 * for the most common Mozilla APIs. Types are intentionally loose
 * (`any`) because full Firefox type coverage is out of scope.
 *
 * Structured globals (`ChromeUtils`, `Localization`) are declared via
 * named global interfaces (`ChromeUtilsShim`, `LocalizationShim`, …)
 * rather than closed object-literal types, so a project's extra shim
 * (`patchLint.checkJsExtraShim` / `typecheck.extraShim`) can ADD members
 * through TypeScript interface merging:
 *
 *   // my-extra-shim.d.ts
 *   interface ChromeUtilsShim {
 *     someNewApi(arg: string): unknown;
 *   }
 *
 * (A second `declare var ChromeUtils` in the extra shim remains a
 * duplicate-identifier error by design — merge the interface instead.)
 * The member lists track upstream WebIDL additions per Firefox release
 * (`dom/chrome-webidl/ChromeUtils.webidl` for ChromeUtils); when a new
 * release adds a commonly-patched member, add a loose signature here.
 *
 * Notable patterns that require shimming:
 * - `const lazy = {};` + `ChromeUtils.defineESModuleGetters(lazy, { ... })`
 *   populates `lazy` at runtime; we declare it as `Record<string, any>`.
 * - `Services.obs`, `Services.prefs`, etc. are XPCOM service accessors.
 * - `Ci`, `Cc`, `Cr`, `Cu` are XPCOM component shortcuts.
 * - Browser chrome globals like `gBrowser`, `gURLBar` are common in
 *   content scripts wired via `browser.js`.
 * - Dynamic `import("resource:-…")` / `import("chrome:-…")` under patch
 *   checkJs: imports of *patch-owned* modules resolve to their real
 *   sources (see `patch-lint-checkjs.ts`); everything else fails host
 *   resolution and lands on these URL ambient wildcards, keeping
 *   upstream Firefox imports pragmatically loose, same posture as globals.
 */
const FIREFOX_GLOBALS_SHIM = `
declare var Services: any;
// Extensible via interface merging from a project extra shim — see the
// module doc comment in typecheck-shim.ts.
interface ChromeUtilsShim {
  defineESModuleGetters(target: any, modules: Record<string, string>): void;
  importESModule(specifier: string): any;
  import(specifier: string): any;
  registerWindowActor(name: string, options: Record<string, any>): void;
  defineModuleGetter(target: any, name: string, specifier: string): void;
  defineLazyGetter(target: any, name: string, getter: () => any): void;
  generateQI(interfaces: any[]): Function;
  getClassName(obj: any, unwrap?: boolean): string;
  isClassInfo(obj: any): boolean;
  // Firefox 153, dom/chrome-webidl/ChromeUtils.webidl: two overloads
  // (URI string / nsIURI) with a PredictRemoteTypeOptions dictionary —
  // collapsed into one loose signature per the shim's pragmatic posture.
  predictRemoteTypeForURI(uri: string | object | null, options?: object): string | null;
}
declare var ChromeUtils: ChromeUtilsShim;
declare var Cu: any;
declare var Ci: any;
declare var Cc: any;
declare var Cr: any;
declare var Components: any;
declare var XPCOMUtils: any;
declare var lazy: Record<string, any>;
declare var PathUtils: any;
declare var IOUtils: any;
declare var FileUtils: any;
declare var gBrowser: any;
declare var gURLBar: any;
declare var gNavigatorBundle: any;
declare var AppConstants: any;
declare class JSWindowActorChild {
  readonly browsingContext: any;
  readonly contentWindow: any;
  readonly document: any;
  sendAsyncMessage(name: string, data?: any, transfers?: any[]): void;
  sendQuery(name: string, data?: any, transfers?: any[]): Promise<any>;
}
declare class JSWindowActorParent {
  readonly browsingContext: any;
  sendAsyncMessage(name: string, data?: any, transfers?: any[]): void;
  sendQuery(name: string, data?: any, transfers?: any[]): Promise<any>;
}
// Fluent localization — a stable chrome global. Members stay loose (any),
// but the constructor shape is declared so "new Localization([...])" and
// "new Localization([...], true)" typecheck without a local cast. Both
// interfaces are extensible via interface merging from a project extra
// shim, same as ChromeUtilsShim.
interface LocalizationInstanceShim {
  formatValue(id: string, args?: Record<string, unknown>): any;
  formatValues(keys: any[]): any;
  formatMessages(keys: any[]): any;
  formatValueSync(id: string, args?: Record<string, unknown>): any;
  formatValuesSync(keys: any[]): any;
  formatMessagesSync(keys: any[]): any;
  addResourceIds(ids: Array<string | { path: string; optional?: boolean }>): void;
  removeResourceIds(ids: string[]): number;
  setAsync(): void;
}
interface LocalizationShim {
  new (
    resourceIds: Array<string | { path: string; optional?: boolean }>,
    sync?: boolean
  ): LocalizationInstanceShim;
}
declare var Localization: LocalizationShim;

// Shorthand ambient modules — exports from matching URL imports are loosely typed,
// avoiding noResolve empty-graph namespaces. (Named member access broke when we tried
// export= Record under moduleResolution Bundler.)
declare module 'resource:*';
declare module 'chrome:*';

`;

/**
 * Loose declarations for Firefox test-harness globals (mochitest
 * browser-chrome and xpcshell), appended AFTER the composed
 * Firefox-globals + consumer shim when `patchLint.checkJsTestFiles`
 * extends the checkJs pass to patch-adopted test scripts (FORGE G5).
 * Deliberately `any`-typed — the pragmatic posture matches the main
 * shim. A consumer that wants TYPED harness members (so e.g. a call to
 * a method the harness does not declare fails at the patch boundary)
 * declares them in `patchLint.checkJsTestShim`; because that shim
 * composes BEFORE this baseline and TypeScript resolves conflicting
 * `declare var` redeclarations to the FIRST declaration, the typed
 * consumer declaration wins over the loose fallback here.
 */
export const TEST_HARNESS_SHIM = `
// ── FireForge test-harness shim (loose baseline) ──
declare var TestUtils: any;
declare var BrowserTestUtils: any;
declare var SpecialPowers: any;
declare var EventUtils: any;
declare var SimpleTest: any;
declare var Assert: any;
declare var gTestPath: string;
declare var content: any;
declare function add_task(task: (...args: any[]) => any): any;
declare function add_setup(task: (...args: any[]) => any): any;
declare function ok(condition: any, message?: string): void;
declare function is(actual: any, expected: any, message?: string): void;
declare function isnot(actual: any, expected: any, message?: string): void;
declare function todo(condition: any, message?: string): void;
declare function todo_is(actual: any, expected: any, message?: string): void;
declare function info(message: string): void;
declare function registerCleanupFunction(callback: (...args: any[]) => any): void;
declare function waitForExplicitFinish(): void;
declare function finish(): void;
declare function do_get_profile(): any;
declare function run_test(): any;

`;

/**
 * TS diagnostic codes suppressed by both the patch-lint checkJs pass
 * and the whole-project typecheck command. Each is a known false
 * positive that arises from checking Firefox JS outside Mozilla's own
 * build system: the resolver can't follow `resource://`/`chrome://`
 * URLs and the global shim is intentionally narrow.
 *
 * Widening this set should be deliberate and per-code — silently
 * suppressing more codes hides real type errors. The same set is used
 * by both flows so a patch can't pass one and fail the other for a
 * reason the operator couldn't infer from the docs.
 */
export const SUPPRESSED_DIAGNOSTIC_CODES: ReadonlySet<number> = new Set([
  2307, // Cannot find module '{0}' or its corresponding type declarations.
  2306, // File '{0}' is not a module.
  2305, // Module '{0}' has no exported member '{1}'.
  2792, // Cannot find module '{0}'. Did you mean to set the 'moduleResolution' option...
  2580, // Cannot find name '{0}'. Do you need to install type definitions...
  7016, // Could not find a declaration file for module '{0}'.
]);

/**
 * Undefined-free-identifier codes, split out of
 * {@link SUPPRESSED_DIAGNOSTIC_CODES} (FORGE F12). Unconditional
 * suppression let a module reference a name with no import or declaration
 * anywhere and still typecheck with 0 errors — the failure then surfaced
 * as a runtime `ReferenceError`. Both flows now report these at a
 * configurable severity (default `'warning'`: visible without breaking
 * gates; genuine shim gaps are silenced by adding the global to
 * `extraShim`, or per-run via the `'off'` setting).
 */
export const UNDEFINED_IDENTIFIER_CODES: ReadonlySet<number> = new Set([
  2304, // Cannot find name '{0}'.
  2552, // Cannot find name '{0}'. Did you mean '{1}'?
]);

/** Hint appended to reported undefined-identifier diagnostics. */
export const UNDEFINED_IDENTIFIER_HINT =
  '(undefined identifier — import or declare it, add the global to the extra shim, ' +
  'or tune the "undefinedIdentifiers" setting)';

/**
 * Result of {@link composeShimSource}: the source body to feed into
 * the TS host plus a flag indicating whether the user-supplied extra
 * shim was actually appended (used for verbose logging).
 */
export interface ComposedShim {
  source: string;
  extraShimAppended: boolean;
}

/** Matches a lone triple-slash `/// <reference path="…" />` directive line. */
const TRIPLE_SLASH_REFERENCE = /^\s*\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']\s*\/?>\s*$/;

/**
 * Inlines triple-slash `/// <reference path="…">` directives in shim source.
 *
 * Both shim consumers feed the text to the compiler at a *synthetic* path
 * (an in-memory source file, not the extra shim's real location), so TS
 * resolves a relative `/// <reference>` against that synthetic directory and
 * silently drops it. Inlining the referenced file's contents (recursively,
 * resolved against the *referencing* file's directory, deduped by absolute
 * path) makes the directives self-contained so their declarations survive.
 *
 * @param source - Shim source possibly containing reference directives
 * @param baseDir - Directory the directives' relative paths resolve against
 * @param seen - Absolute paths already inlined (cycle / duplicate guard)
 */
async function inlineTripleSlashReferences(
  source: string,
  baseDir: string,
  seen: Set<string>
): Promise<string> {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const match = TRIPLE_SLASH_REFERENCE.exec(line);
    if (!match?.[1]) {
      out.push(line);
      continue;
    }
    const absolute = resolve(baseDir, match[1]);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!(await pathExists(absolute))) {
      out.push(`// (fireforge: unresolved /// <reference path="${match[1]}">)`);
      continue;
    }
    const referenced = await readText(absolute);
    out.push(await inlineTripleSlashReferences(referenced, dirname(absolute), seen));
  }
  return out.join('\n');
}

/**
 * Composes the synthetic shim source by concatenating the built-in
 * Firefox globals shim with the contents of an optional user-supplied
 * `.d.ts` file. The user file is appended verbatim — the augment
 * direction is intentional (declarations later in concat order
 * augment earlier ones), so a project that wants to refine `Services`
 * with a more specific type can do so by declaring it in the extra
 * shim, and members can be ADDED to the structured globals by merging
 * their interfaces (`interface ChromeUtilsShim { newMember(): any }` —
 * see the module doc comment). Any triple-slash
 * `/// <reference path="…">` directives inside the
 * extra shim are inlined (resolved against the extra shim's own directory)
 * so they are not silently dropped at the synthetic shim path.
 *
 * Missing extra-shim files raise a clear error rather than failing
 * silently with a confusing "type not found" downstream — this is the
 * one config-driven path where a user typo in `fireforge.json`
 * produces a runtime error, so it needs to be unmistakable.
 *
 * @param projectRoot - Absolute project root, used to resolve the relative shim path
 * @param extraShimPath - Optional project-relative path to an extra `.d.ts`
 */
export async function composeShimSource(
  projectRoot: string,
  extraShimPath: string | undefined
): Promise<ComposedShim> {
  const base = FIREFOX_GLOBALS_SHIM;
  if (!extraShimPath) {
    return { source: base, extraShimAppended: false };
  }
  const absoluteShim = resolve(projectRoot, extraShimPath);
  if (!(await pathExists(absoluteShim))) {
    throw new Error(
      `Extra TypeScript shim not found: ${extraShimPath} (resolved to ${absoluteShim}). ` +
        'Check the path in fireforge.json or create the file.'
    );
  }
  const extra = await readText(absoluteShim);
  const inlinedExtra = await inlineTripleSlashReferences(
    extra,
    dirname(absoluteShim),
    new Set([absoluteShim])
  );
  return {
    source: `${base}\n// ── extraShim: ${extraShimPath} ──\n${inlinedExtra}`,
    extraShimAppended: true,
  };
}
