// SPDX-License-Identifier: EUPL-1.2
/**
 * Optional TypeScript `checkJs` pass for patch-owned `.sys.mjs` files.
 *
 * Loads the TypeScript compiler API via dynamic import so it is only
 * required when `patchLint.checkJs` is enabled in `fireforge.json`.
 * TypeScript remains a dev-dependency — if a user enables checkJs
 * without installing it, the pass emits a clear error explaining
 * how to fix it.
 *
 * Separated from `patch-lint.ts` to keep both files within the
 * project's per-file line budget.
 */

import { resolve } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Firefox globals shim
// ---------------------------------------------------------------------------

const SHIM_FILENAME = '__fireforge_firefox_globals.d.ts';

/**
 * Minimal `.d.ts` shim for Firefox privileged-scope globals.
 *
 * Firefox source is plain JS — no TypeScript allowed. The shim lets
 * `checkJs` run without reporting "cannot find name" for the most
 * common Mozilla APIs. Types are intentionally loose (`any`) because
 * full Firefox type coverage is out of scope.
 *
 * Notable patterns that require shimming:
 * - `const lazy = {};` + `ChromeUtils.defineESModuleGetters(lazy, { ... })`
 *   populates `lazy` at runtime; we declare it as `Record<string, any>`.
 * - `Services.obs`, `Services.prefs`, etc. are XPCOM service accessors.
 * - `Ci`, `Cc`, `Cr`, `Cu` are XPCOM component shortcuts.
 * - Browser chrome globals like `gBrowser`, `gURLBar` are common in
 *   content scripts wired via `browser.js`.
 */
const FIREFOX_GLOBALS_SHIM = `
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
`;

// ---------------------------------------------------------------------------
// Diagnostic filtering
// ---------------------------------------------------------------------------

/**
 * TS diagnostic codes to suppress because they are inherent to
 * checking Firefox JS files outside of Mozilla's own build system.
 *
 * Firefox uses `resource://` and `chrome://` URL schemes for module
 * imports. TypeScript's module resolver cannot follow these, so every
 * import from an upstream Firefox module produces a spurious
 * "Cannot find module" error. Filtering these out is essential to
 * keep the checkJs pass usable — otherwise every file with an import
 * would be buried in false positives.
 */
const SUPPRESSED_DIAGNOSTIC_CODES = new Set([
  2307, // Cannot find module '{0}' or its corresponding type declarations.
  2306, // File '{0}' is not a module.
  2305, // Module '{0}' has no exported member '{1}'.
  2792, // Cannot find module '{0}'. Did you mean to set the 'moduleResolution' option...
  2304, // Cannot find name '{0}'. (for globals we missed in the shim)
  2552, // Cannot find name '{0}'. Did you mean '{1}'?
  2580, // Cannot find name '{0}'. Do you need to install type definitions...
  7016, // Could not find a declaration file for module '{0}'.
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs TypeScript's checkJs pass on patch-owned `.sys.mjs` files.
 *
 * @param repoDir - Absolute path to the engine (repository) directory
 * @param patchOwnedFiles - Set of patch-owned `.sys.mjs` file paths (relative to repoDir)
 * @returns Array of lint issues from TS diagnostics
 */
export async function runCheckJs(
  repoDir: string,
  patchOwnedFiles: Set<string>
): Promise<PatchLintIssue[]> {
  if (patchOwnedFiles.size === 0) return [];

  // Dynamic import — typescript stays as a dev dependency
  let ts: typeof import('typescript');
  try {
    ts = await import('typescript');
  } catch {
    return [
      {
        file: '(checkJs)',
        check: 'checkjs-type-error',
        message:
          'patchLint.checkJs is enabled but the "typescript" package is not installed. ' +
          'Run "npm install typescript" to enable type checking.',
        severity: 'error',
      },
    ];
  }

  // Resolve absolute paths for root files, filtering to files that exist
  const rootFiles: string[] = [];
  const ownedAbsolute = new Set<string>();
  for (const rel of patchOwnedFiles) {
    const abs = resolve(repoDir, rel);
    if (await pathExists(abs)) {
      rootFiles.push(abs);
      ownedAbsolute.add(abs);
    }
  }

  if (rootFiles.length === 0) return [];

  const shimPath = resolve(repoDir, SHIM_FILENAME);
  rootFiles.push(shimPath);

  const options: import('typescript').CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    // Do not follow import/reference directives into the Firefox tree.
    // We only want to check the patch-owned files themselves.
    // Without this, TS would try (and fail) to resolve every
    // resource:// and chrome:// import, flooding the output with
    // "Cannot find module" errors for upstream Firefox modules.
    noResolve: true,
    // Suppress implicit-any noise — Firefox code rarely has full type
    // annotations and drowning users in thousands of implicit-any
    // errors defeats the purpose of a focused check.
    noImplicitAny: false,
  };

  // Custom compiler host: reads patch-owned files from disk, returns
  // the shim for the shim path, and returns empty content for
  // anything else to avoid reading the full Firefox tree.
  const defaultHost = ts.createCompilerHost(options);
  const host: import('typescript').CompilerHost = {
    ...defaultHost,
    getSourceFile(fileName, languageVersion, onError) {
      if (fileName === shimPath) {
        return ts.createSourceFile(fileName, FIREFOX_GLOBALS_SHIM, languageVersion, true);
      }
      if (ownedAbsolute.has(fileName)) {
        return defaultHost.getSourceFile(fileName, languageVersion, onError);
      }
      // For lib files (lib.es*.d.ts) delegate to the default host
      // so built-in types like Promise, Array, etc. are available.
      if (fileName.includes('lib.') && fileName.endsWith('.d.ts')) {
        return defaultHost.getSourceFile(fileName, languageVersion, onError);
      }
      // Return an empty source file for anything else to avoid
      // reading unrelated Firefox source files.
      return ts.createSourceFile(fileName, '', languageVersion, true);
    },
    fileExists(fileName) {
      if (fileName === shimPath) return true;
      if (ownedAbsolute.has(fileName)) return true;
      return defaultHost.fileExists(fileName);
    },
    readFile(fileName) {
      if (fileName === shimPath) return FIREFOX_GLOBALS_SHIM;
      return defaultHost.readFile(fileName);
    },
  };

  const program = ts.createProgram(rootFiles, options, host);
  const allDiagnostics = [
    ...program.getSemanticDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ];

  // Filter to diagnostics originating in patch-owned files only,
  // and suppress module-resolution / unknown-name noise that is
  // inherent to checking Firefox JS outside Mozilla's build system.
  const issues: PatchLintIssue[] = [];
  for (const diag of allDiagnostics) {
    if (SUPPRESSED_DIAGNOSTIC_CODES.has(diag.code)) continue;
    const sourceFile = diag.file;
    if (!sourceFile) continue;
    if (!ownedAbsolute.has(sourceFile.fileName)) continue;

    const lineInfo = sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0);
    const line = lineInfo.line + 1;
    const messageText =
      typeof diag.messageText === 'string'
        ? diag.messageText
        : ts.flattenDiagnosticMessageText(diag.messageText, '\n');

    // Find the relative path for the issue
    let relPath = sourceFile.fileName;
    for (const [rel, abs] of [...patchOwnedFiles].map((r) => [r, resolve(repoDir, r)] as const)) {
      if (abs === sourceFile.fileName) {
        relPath = rel;
        break;
      }
    }

    const severity = diag.category === ts.DiagnosticCategory.Error ? 'error' : ('warning' as const);

    issues.push({
      file: relPath,
      check: 'checkjs-type-error',
      message: `Line ${line}: ${messageText}`,
      severity,
    });
  }

  verbose(`checkJs: analyzed ${rootFiles.length - 1} file(s), found ${issues.length} issue(s)`);
  return issues;
}
