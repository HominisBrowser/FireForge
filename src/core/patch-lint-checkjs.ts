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
 * project's per-file line budget. The shim itself and the suppressed
 * diagnostic code list now live in `typecheck-shim.ts` and are shared
 * with the whole-project `fireforge typecheck` command — keeping a
 * single source of truth for the Firefox-globals coverage.
 * `patchLint.checkJsStrict` only tightens `strict` / `noImplicitAny`
 * and optional allowlisted `checkJsCompilerOptions`; it does not change
 * shim composition or suppressed diagnostic codes.
 */

import { basename, resolve } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { PatchLintCheckJsCompilerOptions, PatchLintConfig } from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { composeShimSource, SHIM_FILENAME, SUPPRESSED_DIAGNOSTIC_CODES } from './typecheck-shim.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the host-side module resolver for the checkJs pass: maps an import
 * specifier to a patch-owned absolute path when the specifier's final
 * segment uniquely matches an owned file. URL specifiers
 * (chrome://browser/content/Foo.sys.mjs, resource:///modules/Foo.sys.mjs)
 * are matched by basename, with a `.mjs` → `.sys.mjs` fallback for deployed
 * widget URLs. Ambiguous or unknown basenames stay unresolved — loose
 * wildcard typing beats guessing the wrong module — and relative specifiers
 * are left to fail resolution (the relative-import lint rule bans them).
 */
function createOwnedSpecifierResolver(
  ts: typeof import('typescript'),
  ownedAbsolute: ReadonlySet<string>
): (specifier: string) => import('typescript').ResolvedModuleFull | undefined {
  const ownedByBasename = new Map<string, string[]>();
  for (const abs of ownedAbsolute) {
    const base = basename(abs);
    const list = ownedByBasename.get(base) ?? [];
    list.push(abs);
    ownedByBasename.set(base, list);
  }

  return (specifier) => {
    if (specifier.startsWith('.')) return undefined;
    const cleaned = specifier.split(/[?#]/)[0] ?? specifier;
    const segment = cleaned.slice(cleaned.lastIndexOf('/') + 1);
    if (!segment) return undefined;
    const candidates = [...(ownedByBasename.get(segment) ?? [])];
    if (segment.endsWith('.mjs') && !segment.endsWith('.sys.mjs')) {
      candidates.push(...(ownedByBasename.get(segment.replace(/\.mjs$/, '.sys.mjs')) ?? []));
    }
    if (candidates.length !== 1) return undefined;
    return {
      resolvedFileName: candidates[0] as string,
      extension: ts.Extension.Mjs,
      isExternalLibraryImport: false,
    };
  };
}

/**
 * Runs TypeScript's checkJs pass on patch-owned `.sys.mjs` files.
 *
 * @param repoDir - Absolute path to the engine (repository) directory
 * @param patchOwnedFiles - Set of patch-owned `.sys.mjs` file paths (relative to repoDir)
 * @param extraShimPath - Optional project-relative path to an additional
 *   `.d.ts` file whose contents are concatenated to the built-in
 *   Firefox-globals shim. Sourced from `patchLint.checkJsExtraShim`.
 *   Resolved against `projectRoot` (one level up from `repoDir` is the
 *   wrong root — patches sit inside `engine/` while the shim lives at
 *   the project root, so the caller passes both).
 * @param projectRoot - Absolute project root for resolving `extraShimPath`.
 *   Defaults to `repoDir` for back-compat with callers that don't
 *   pass an extra shim (no resolution actually happens in that case).
 * @param mode - When `strict` is true, enables `strict` and `noImplicitAny`
 *   (CI-style). Optional `compilerOptions` merges allowlisted boolean
 *   overrides after that preset (from `patchLint.checkJsCompilerOptions`).
 *   Omitted or `{ strict: false }` preserves the historical loose preset.
 * @returns Array of lint issues from TS diagnostics
 */
export async function runCheckJs(
  repoDir: string,
  patchOwnedFiles: Set<string>,
  extraShimPath?: string,
  projectRoot?: string,
  mode?: { strict: boolean; compilerOptions?: PatchLintCheckJsCompilerOptions }
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

  // Compose the shim. `extraShimPath` is project-relative (validated
  // by config-validate); resolve it against `projectRoot`. When the
  // caller passes neither, fall back to `repoDir` — the only way the
  // shim path is ever read in that case is when extraShimPath is
  // also undefined, so the resolution target is irrelevant.
  let shimSource: string;
  try {
    const composed = await composeShimSource(projectRoot ?? repoDir, extraShimPath);
    shimSource = composed.source;
    if (composed.extraShimAppended) {
      verbose(`checkJs: extra shim ${extraShimPath ?? ''} appended to Firefox globals shim`);
    }
  } catch (err) {
    return [
      {
        file: extraShimPath ?? '(checkJs)',
        check: 'checkjs-type-error',
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      },
    ];
  }

  const shimPath = resolve(repoDir, SHIM_FILENAME);
  rootFiles.push(shimPath);

  const strict = mode?.strict === true;
  const strictness: import('typescript').CompilerOptions = strict
    ? { strict: true, noImplicitAny: true }
    : {
        // Loose default — implicit `any` is allowed unless `patchLint.checkJsStrict`.
        strict: false,
        noImplicitAny: false,
      };

  const overrides: import('typescript').CompilerOptions = {};
  const co = mode?.compilerOptions;
  if (co) {
    for (const key of Object.keys(co) as (keyof PatchLintCheckJsCompilerOptions)[]) {
      const v = co[key];
      if (v !== undefined) {
        (overrides as Record<string, boolean>)[key] = v;
      }
    }
  }

  const options: import('typescript').CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    // Module resolution is host-controlled (see resolveOwnedSpecifier
    // below): imports that match a patch-owned file resolve to the real
    // source so JSDoc type-guard predicates and @template generics
    // survive the module boundary; everything else deliberately fails
    // resolution, falling back to the chrome:*/resource:* ambient
    // wildcards plus the suppressed "cannot find module" codes. The
    // host resolver is authoritative — TS never crawls the Firefox
    // tree looking for upstream modules.
    ...strictness,
    ...overrides,
  };

  const resolveOwnedSpecifier = createOwnedSpecifierResolver(ts, ownedAbsolute);

  // Custom compiler host: reads patch-owned files from disk, returns
  // the shim for the shim path, and returns empty content for
  // anything else to avoid reading the full Firefox tree.
  const defaultHost = ts.createCompilerHost(options);
  const host: import('typescript').CompilerHost = {
    ...defaultHost,
    getSourceFile(fileName, languageVersion, onError) {
      if (fileName === shimPath) {
        return ts.createSourceFile(fileName, shimSource, languageVersion, true);
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
      if (fileName === shimPath) return shimSource;
      return defaultHost.readFile(fileName);
    },
    resolveModuleNameLiterals(moduleLiterals) {
      return moduleLiterals.map((literal) => ({
        resolvedModule: resolveOwnedSpecifier(literal.text),
      }));
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

/**
 * Invokes {@link runCheckJs} for a `patchLint` block with `checkJs: true`.
 * `projectRoot` is the FireForge project root (`dirname(engine)`).
 */
export async function invokePatchLintCheckJs(
  repoDir: string,
  patchOwnedFiles: Set<string>,
  patchLint: PatchLintConfig,
  projectRoot: string
): Promise<PatchLintIssue[]> {
  const strict = patchLint.checkJsStrict === true;
  const mode =
    strict && patchLint.checkJsCompilerOptions
      ? { strict, compilerOptions: patchLint.checkJsCompilerOptions }
      : { strict };
  return runCheckJs(repoDir, patchOwnedFiles, patchLint.checkJsExtraShim, projectRoot, mode);
}
