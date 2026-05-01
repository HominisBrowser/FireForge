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

import { resolve } from 'node:path';

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
 * Notable patterns that require shimming:
 * - `const lazy = {};` + `ChromeUtils.defineESModuleGetters(lazy, { ... })`
 *   populates `lazy` at runtime; we declare it as `Record<string, any>`.
 * - `Services.obs`, `Services.prefs`, etc. are XPCOM service accessors.
 * - `Ci`, `Cc`, `Cr`, `Cu` are XPCOM component shortcuts.
 * - Browser chrome globals like `gBrowser`, `gURLBar` are common in
 *   content scripts wired via `browser.js`.
 * - Dynamic `import("resource:-…")` / `import("chrome:-…")` under patch
 *   checkJs: the compiler sees empty stubs (`noResolve`); without URL
 *   ambient modules namespaces degrade to unusable typings. Wildcards
 *   keep Firefox URL imports pragmatically loose, same posture as globals.
 */
export const FIREFOX_GLOBALS_SHIM = `
declare var Services: any;
declare var ChromeUtils: {
  defineESModuleGetters(target: any, modules: Record<string, string>): void;
  importESModule(specifier: string): any;
  import(specifier: string): any;
  defineModuleGetter(target: any, name: string, specifier: string): void;
  generateQI(interfaces: any[]): Function;
  isClassInfo(obj: any): boolean;
};
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

// Shorthand ambient modules — exports from matching URL imports are loosely typed,
// avoiding noResolve empty-graph namespaces. (Named member access broke when we tried
// export= Record under moduleResolution Bundler.)
declare module 'resource:*';
declare module 'chrome:*';

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
  2304, // Cannot find name '{0}'. (for globals we missed in the shim)
  2552, // Cannot find name '{0}'. Did you mean '{1}'?
  2580, // Cannot find name '{0}'. Do you need to install type definitions...
  7016, // Could not find a declaration file for module '{0}'.
]);

/**
 * Result of {@link composeShimSource}: the source body to feed into
 * the TS host plus a flag indicating whether the user-supplied extra
 * shim was actually appended (used for verbose logging).
 */
export interface ComposedShim {
  source: string;
  extraShimAppended: boolean;
}

/**
 * Composes the synthetic shim source by concatenating the built-in
 * Firefox globals shim with the contents of an optional user-supplied
 * `.d.ts` file. The user file is appended verbatim — the augment
 * direction is intentional (declarations later in concat order
 * augment earlier ones), so a project that wants to refine `Services`
 * with a more specific type can do so by declaring it in the extra
 * shim.
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
  if (!extraShimPath) {
    return { source: FIREFOX_GLOBALS_SHIM, extraShimAppended: false };
  }
  const absoluteShim = resolve(projectRoot, extraShimPath);
  if (!(await pathExists(absoluteShim))) {
    throw new Error(
      `Extra TypeScript shim not found: ${extraShimPath} (resolved to ${absoluteShim}). ` +
        'Check the path in fireforge.json or create the file.'
    );
  }
  const extra = await readText(absoluteShim);
  return {
    source: `${FIREFOX_GLOBALS_SHIM}\n// ── extraShim: ${extraShimPath} ──\n${extra}`,
    extraShimAppended: true,
  };
}
