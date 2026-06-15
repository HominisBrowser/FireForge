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
 *
 * Resolution scope vs reporting scope: the TS program is built over a
 * *resolution* set (every patch-owned `.sys.mjs` the run cares about, so
 * cross-patch `resource:///` imports resolve to their real sources), while
 * diagnostics are emitted only for files in the *report* scope. Splitting
 * the two lets per-patch lint build one queue-wide program and attribute
 * findings per patch, and lets export/re-export resolve cross-patch imports
 * while reporting only the patch under export.
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

/** Maps a resolved file path to the TS extension enum the host must report. */
function extensionForFile(
  ts: typeof import('typescript'),
  file: string
): import('typescript').Extension {
  if (file.endsWith('.d.ts')) return ts.Extension.Dts;
  if (file.endsWith('.ts')) return ts.Extension.Ts;
  if (file.endsWith('.tsx')) return ts.Extension.Tsx;
  if (file.endsWith('.cjs')) return ts.Extension.Cjs;
  if (file.endsWith('.jsx')) return ts.Extension.Jsx;
  if (file.endsWith('.json')) return ts.Extension.Json;
  return ts.Extension.Mjs;
}

/**
 * Builds a resolver for a reviewed `paths` mapping (route 2 of the
 * cross-patch resolution work). Each pattern may contain a single `*`;
 * matching targets are resolved relative to `baseDir` (the engine dir, like
 * the rest of `patchLint` which is engine-relative). Resolved files are
 * recorded via `onResolved` so the compiler host knows to read them from
 * disk rather than returning empty content. No `baseUrl` is set, so this is
 * TS5090-safe: `paths` resolution is host-driven here, not config-driven.
 */
function createPathsResolver(
  ts: typeof import('typescript'),
  paths: Record<string, string[]>,
  baseDir: string,
  fileExists: (file: string) => boolean,
  onResolved: (absolute: string) => void
): (specifier: string) => import('typescript').ResolvedModuleFull | undefined {
  const entries = Object.entries(paths);
  return (specifier) => {
    for (const [pattern, targets] of entries) {
      const star = pattern.indexOf('*');
      let captured: string;
      if (star === -1) {
        if (specifier !== pattern) continue;
        captured = '';
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.length < prefix.length + suffix.length) continue;
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
        captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
      for (const target of targets) {
        const rel = target.includes('*') ? target.replace('*', captured) : target;
        const abs = resolve(baseDir, rel);
        if (!fileExists(abs)) continue;
        onResolved(abs);
        return {
          resolvedFileName: abs,
          extension: extensionForFile(ts, abs),
          isExternalLibraryImport: false,
        };
      }
    }
    return undefined;
  };
}

/** How a checkJs run controls reporting and resolution; see module docs. */
export interface CheckJsMode {
  strict: boolean;
  compilerOptions?: PatchLintCheckJsCompilerOptions;
}

/**
 * Result of {@link runCheckJsGrouped}: diagnostics attributed to the
 * patch-owned file they originate in (`byFile`, keyed by repo-relative
 * path), plus run-level errors that have no owning file (`global` — e.g.
 * TypeScript missing or an unreadable extra shim).
 */
export interface GroupedCheckJsResult {
  byFile: Map<string, PatchLintIssue[]>;
  global: PatchLintIssue[];
}

/**
 * Builds the checkJs program **once** over `resolutionOwned` and returns its
 * diagnostics grouped by originating file. Callers slice the result by their
 * own report scope — per-patch lint attributes each file to its owning
 * patch, export/re-export keeps only the patch under export. Resolution
 * always spans every file in `resolutionOwned`, so cross-patch
 * `resource:///`/`chrome://` imports resolve to real sources.
 *
 * @param repoDir - Absolute engine (repository) directory
 * @param resolutionOwned - Patch-owned `.sys.mjs` paths (relative to repoDir)
 *   the program should see and resolve against
 * @param extraShimPath - Optional project-relative extra `.d.ts` appended to
 *   the built-in Firefox-globals shim (from `patchLint.checkJsExtraShim`)
 * @param projectRoot - Absolute project root for resolving `extraShimPath`
 * @param mode - Strictness preset plus allowlisted compiler-option overrides
 * @returns Diagnostics grouped per owning file plus run-level errors
 */
export async function runCheckJsGrouped(
  repoDir: string,
  resolutionOwned: Set<string>,
  extraShimPath?: string,
  projectRoot?: string,
  mode?: CheckJsMode
): Promise<GroupedCheckJsResult> {
  const empty: GroupedCheckJsResult = { byFile: new Map(), global: [] };
  if (resolutionOwned.size === 0) return empty;

  // Dynamic import — typescript stays as a dev dependency
  let ts: typeof import('typescript');
  try {
    ts = await import('typescript');
  } catch {
    return {
      byFile: new Map(),
      global: [
        {
          file: '(checkJs)',
          check: 'checkjs-type-error',
          message:
            'patchLint.checkJs is enabled but the "typescript" package is not installed. ' +
            'Run "npm install typescript" to enable type checking.',
          severity: 'error',
        },
      ],
    };
  }

  // Resolve absolute paths for root files, filtering to files that exist
  const rootFiles: string[] = [];
  const ownedAbsolute = new Set<string>();
  const relByAbsolute = new Map<string, string>();
  for (const rel of resolutionOwned) {
    const abs = resolve(repoDir, rel);
    if (await pathExists(abs)) {
      rootFiles.push(abs);
      ownedAbsolute.add(abs);
      relByAbsolute.set(abs, rel);
    }
  }

  if (rootFiles.length === 0) return empty;

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
    return {
      byFile: new Map(),
      global: [
        {
          file: extraShimPath ?? '(checkJs)',
          check: 'checkjs-type-error',
          message: err instanceof Error ? err.message : String(err),
          severity: 'error',
        },
      ],
    };
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

  // Allowlisted overrides. Booleans merge directly; a reviewed `paths`
  // mapping is applied to the compiler options AND wired into the host
  // resolver below so patch-owned modules can be typed from their real
  // sources without a hand-generated ambient stub shim.
  const overrides: import('typescript').CompilerOptions = {};
  let pathsMapping: Record<string, string[]> | undefined;
  const co = mode?.compilerOptions;
  if (co) {
    for (const key of Object.keys(co) as (keyof PatchLintCheckJsCompilerOptions)[]) {
      const v = co[key];
      if (v === undefined) continue;
      if (key === 'paths') {
        pathsMapping = v as Record<string, string[]>;
        overrides.paths = pathsMapping;
      } else {
        (overrides as Record<string, boolean>)[key] = v as boolean;
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
  // Files pulled in via a reviewed `paths` mapping — outside the owned set
  // but read from disk so the resolver's targets actually type-check.
  const pathsResolved = new Set<string>();
  const resolveViaPaths = pathsMapping
    ? createPathsResolver(
        ts,
        pathsMapping,
        repoDir,
        (f) => defaultHost.fileExists(f),
        (abs) => pathsResolved.add(abs)
      )
    : undefined;
  const host: import('typescript').CompilerHost = {
    ...defaultHost,
    getSourceFile(fileName, languageVersion, onError) {
      if (fileName === shimPath) {
        return ts.createSourceFile(fileName, shimSource, languageVersion, true);
      }
      if (ownedAbsolute.has(fileName) || pathsResolved.has(fileName)) {
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
      if (ownedAbsolute.has(fileName) || pathsResolved.has(fileName)) return true;
      return defaultHost.fileExists(fileName);
    },
    readFile(fileName) {
      if (fileName === shimPath) return shimSource;
      return defaultHost.readFile(fileName);
    },
    resolveModuleNameLiterals(moduleLiterals) {
      return moduleLiterals.map((literal) => {
        const owned = resolveOwnedSpecifier(literal.text);
        if (owned) return { resolvedModule: owned };
        return { resolvedModule: resolveViaPaths?.(literal.text) };
      });
    },
  };

  const program = ts.createProgram(rootFiles, options, host);
  const byFile = groupOwnedDiagnostics(
    ts,
    [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()],
    relByAbsolute
  );

  verbose(`checkJs: analyzed ${rootFiles.length - 1} file(s) across ${byFile.size} owning file(s)`);
  return { byFile, global: [] };
}

/**
 * Groups TS diagnostics by the patch-owned file they originate in,
 * suppressing module-resolution / unknown-name noise inherent to checking
 * Firefox JS outside Mozilla's build system. Diagnostics from `paths`-resolved
 * or shim files are dropped — only owned files (in `relByAbsolute`) carry
 * findings.
 */
function groupOwnedDiagnostics(
  ts: typeof import('typescript'),
  diagnostics: readonly import('typescript').Diagnostic[],
  relByAbsolute: ReadonlyMap<string, string>
): Map<string, PatchLintIssue[]> {
  const byFile = new Map<string, PatchLintIssue[]>();
  for (const diag of diagnostics) {
    if (SUPPRESSED_DIAGNOSTIC_CODES.has(diag.code)) continue;
    const sourceFile = diag.file;
    if (!sourceFile) continue;
    const relPath = relByAbsolute.get(sourceFile.fileName);
    if (relPath === undefined) continue;

    const lineInfo = sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0);
    const line = lineInfo.line + 1;
    const messageText =
      typeof diag.messageText === 'string'
        ? diag.messageText
        : ts.flattenDiagnosticMessageText(diag.messageText, '\n');
    const severity = diag.category === ts.DiagnosticCategory.Error ? 'error' : ('warning' as const);

    const bucket = byFile.get(relPath) ?? [];
    bucket.push({
      file: relPath,
      check: 'checkjs-type-error',
      message: `Line ${line}: ${messageText}`,
      severity,
    });
    byFile.set(relPath, bucket);
  }
  return byFile;
}

/**
 * Flattens a {@link runCheckJsGrouped} run into a single issue list. When
 * `reportScope` is supplied, only diagnostics from files in that set are
 * returned (resolution still spans every owned file); omitting it reports
 * every owned file's diagnostics — the historical whole-set behaviour.
 *
 * @param repoDir - Absolute engine (repository) directory
 * @param patchOwnedFiles - Patch-owned `.sys.mjs` paths to resolve against
 * @param extraShimPath - Optional project-relative extra `.d.ts`
 * @param projectRoot - Absolute project root for resolving `extraShimPath`
 * @param mode - Strictness preset plus allowlisted compiler-option overrides
 * @param reportScope - When set, restrict reported diagnostics to these
 *   repo-relative files
 * @returns Array of lint issues from TS diagnostics
 */
export async function runCheckJs(
  repoDir: string,
  patchOwnedFiles: Set<string>,
  extraShimPath?: string,
  projectRoot?: string,
  mode?: CheckJsMode,
  reportScope?: ReadonlySet<string>
): Promise<PatchLintIssue[]> {
  const { byFile, global } = await runCheckJsGrouped(
    repoDir,
    patchOwnedFiles,
    extraShimPath,
    projectRoot,
    mode
  );
  const issues = [...global];
  for (const [rel, list] of byFile) {
    if (reportScope && !reportScope.has(rel)) continue;
    issues.push(...list);
  }
  return issues;
}

/**
 * Invokes {@link runCheckJs} for a `patchLint` block with `checkJs: true`.
 * `projectRoot` is the FireForge project root (`dirname(engine)`).
 *
 * @param repoDir - Absolute engine (repository) directory
 * @param patchOwnedFiles - Patch-owned `.sys.mjs` paths to resolve against
 * @param patchLint - The resolved `patchLint` config block
 * @param projectRoot - FireForge project root for shim resolution
 * @param reportScope - Optional repo-relative files to report on (export /
 *   re-export passes the patch under export so cross-patch resolution does
 *   not surface other patches' diagnostics)
 */
export async function invokePatchLintCheckJs(
  repoDir: string,
  patchOwnedFiles: Set<string>,
  patchLint: PatchLintConfig,
  projectRoot: string,
  reportScope?: ReadonlySet<string>
): Promise<PatchLintIssue[]> {
  const strict = patchLint.checkJsStrict === true;
  const mode: CheckJsMode =
    strict && patchLint.checkJsCompilerOptions
      ? { strict, compilerOptions: patchLint.checkJsCompilerOptions }
      : { strict };
  return runCheckJs(
    repoDir,
    patchOwnedFiles,
    patchLint.checkJsExtraShim,
    projectRoot,
    mode,
    reportScope
  );
}

/**
 * Grouped variant of {@link invokePatchLintCheckJs}: builds one queue-wide
 * checkJs program over `patchOwnedFiles` and returns its findings grouped by
 * owning file. The per-patch lint orchestrator calls this **once per run**
 * and attributes each file's findings to its owning patch, instead of
 * rebuilding the same program for every patch in the queue.
 *
 * @param repoDir - Absolute engine (repository) directory
 * @param patchOwnedFiles - Every patch-owned `.sys.mjs` in the queue
 * @param patchLint - The resolved `patchLint` config block
 * @param projectRoot - FireForge project root for shim resolution
 */
export async function invokePatchLintCheckJsGrouped(
  repoDir: string,
  patchOwnedFiles: Set<string>,
  patchLint: PatchLintConfig,
  projectRoot: string
): Promise<GroupedCheckJsResult> {
  const strict = patchLint.checkJsStrict === true;
  const mode: CheckJsMode =
    strict && patchLint.checkJsCompilerOptions
      ? { strict, compilerOptions: patchLint.checkJsCompilerOptions }
      : { strict };
  return runCheckJsGrouped(repoDir, patchOwnedFiles, patchLint.checkJsExtraShim, projectRoot, mode);
}
