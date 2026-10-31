// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge typecheck --explain <file>`: which of the two typecheck
 * programs see one file, and how, without checking anything.
 *
 * The project pass sees every root of a configured jsconfig project,
 * with that project's shim settings. A per-patch checkJs program sees much
 * less: a patch-created `.sys.mjs` module is checked in the queue-wide
 * module program, a patch-created test script in its own program with its
 * directory's patch-owned heads and the modules the queue creates up to
 * its patch, and nothing else is checked per patch at all. A URL import
 * that program cannot resolve types as `any` there. The explanation is
 * assembled from the same helpers the programs are built from, so it
 * cannot drift from them.
 */

import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  FireForgeConfig,
  PatchLintSeverityGate,
  ProjectPaths,
  TypecheckConfig,
} from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { buildPatchQueueContext, collectNewFileCreatorsByPath } from './patch-lint.js';
import { createOwnedPathMatcher, pathsTargetCandidates } from './patch-lint-checkjs-resolve.js';
import type { PatchQueueContext } from './patch-lint-cross.js';
import {
  isTestScriptFile,
  resolvableModulesForTests,
  resolvePatchOwnedSysMjs,
  resolvePatchOwnedTestScripts,
} from './patch-lint-ownership.js';
import { findProjectOverrideKey, resolveProjectExtraShim } from './typecheck.js';

/** How one configured project relates to the file. */
export interface ProjectExplanation {
  /** The project's jsconfig path, as configured. */
  project: string;
  /**
   * `root`: the jsconfig lists the file. `not-root`: it does not, so the
   * project checks the file only when a root imports it. `skipped`: the
   * project sets `checkJs: false`. `unreadable`: see `detail`.
   */
  membership: 'root' | 'not-root' | 'skipped' | 'unreadable';
  /** Why the project could not be read. */
  detail?: string;
  /** `typecheck.litTypes`. */
  litTypes: boolean;
  /** The effective extra shim. */
  extraShim?: string;
  /** The `projectOverrides` key that applies to the project. */
  overrideKey?: string;
  /** `typecheck.undefinedIdentifiers`. */
  undefinedIdentifiers: PatchLintSeverityGate;
}

/** One URL import and what the per-patch program resolves it to. */
export interface ExplainedImport {
  specifier: string;
  /** `owned`: a module the program sees. `paths`: a reviewed mapping. */
  resolution: 'owned' | 'paths' | 'any';
  /** Engine-relative target, when resolved. */
  target?: string;
}

/** How per-patch checkJs relates to the file. */
export interface PerPatchExplanation {
  /** `patchLint.checkJs`. */
  enabled: boolean;
  /** The file's path inside `engine/`, when it is there. */
  engineFile?: string;
  /** Patches that create the file, in queue order. */
  creators: string[];
  /** Patches that modify it without creating it, in queue order. */
  modifiers: string[];
  /**
   * `module`: a root of the queue-wide `.sys.mjs` program. `test`: the root
   * of its own test-script program. `none`: no per-patch program checks it.
   */
  program: 'module' | 'test' | 'none';
  /** Why no per-patch program checks it. */
  reason?: string;
  /** For a `test`: the patch-owned heads its program loads beside it. */
  heads: string[];
  /** Modules the program resolves imports to (excluding the file). */
  resolvable: string[];
  /** The file's URL imports and how they resolve. */
  imports: ExplainedImport[];
  /** The consumer shim the program appends, if any. */
  shim?: string;
  litTypes: boolean;
  strict: boolean;
  undefinedIdentifiers: PatchLintSeverityGate;
}

/** The whole explanation. */
export interface TypecheckExplanation {
  /** The file, project-relative when inside the project. */
  file: string;
  /** False when the file does not exist. */
  exists: boolean;
  projects: ProjectExplanation[];
  perPatch: PerPatchExplanation;
}

const HEAD_SCRIPT = /^head(?:_.*)?\.js$/;

/** URL specifiers in static imports, `import()` calls and JSDoc `import("…")` types. */
function findUrlImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bfrom\s*["']([^"']+)["']/g,
    /^\s*import\s*["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && /^(?:resource|chrome):/.test(specifier)) {
        found.add(specifier);
      }
    }
  }
  return [...found].sort();
}

async function explainProject(
  ts: typeof import('typescript') | undefined,
  projectRoot: string,
  cfg: TypecheckConfig,
  project: string,
  absoluteFile: string
): Promise<ProjectExplanation> {
  const extraShim = resolveProjectExtraShim(cfg, project, projectRoot);
  const overrideKey = findProjectOverrideKey(cfg, project, projectRoot);
  const base: ProjectExplanation = {
    project,
    membership: 'unreadable',
    litTypes: cfg.litTypes === true,
    ...(extraShim !== undefined ? { extraShim } : {}),
    ...(overrideKey !== undefined ? { overrideKey } : {}),
    undefinedIdentifiers: cfg.undefinedIdentifiers ?? 'warning',
  };
  if (ts === undefined) return { ...base, detail: 'the "typescript" package is not installed' };
  const absConfig = resolve(projectRoot, project);
  if (!(await pathExists(absConfig))) return { ...base, detail: 'the jsconfig does not exist' };
  const read = ts.readConfigFile(absConfig, (path) => ts.sys.readFile(path));
  if (read.error) {
    return { ...base, detail: ts.flattenDiagnosticMessageText(read.error.messageText, ' ') };
  }
  const raw = read.config as { compilerOptions?: Record<string, unknown> } | undefined;
  if (raw?.compilerOptions?.['checkJs'] === false) return { ...base, membership: 'skipped' };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(absConfig),
    undefined,
    absConfig
  );
  const target = normalizePathSlashes(absoluteFile);
  const isRoot = parsed.fileNames.some((name) => normalizePathSlashes(name) === target);
  return { ...base, membership: isRoot ? 'root' : 'not-root' };
}

function noProgramReason(
  file: string,
  creators: readonly string[],
  modifiers: readonly string[],
  testFilesEnabled: boolean
): string {
  if (creators.length === 0) {
    return modifiers.length > 0
      ? 'no patch creates it; per-patch checkJs checks only files a patch creates, so a ' +
          'patch-modified upstream file is checked by the project pass alone'
      : 'no patch creates or modifies it';
  }
  if (isTestScriptFile(file) && !testFilesEnabled) {
    return 'patchLint.checkJsTestFiles is off, so test scripts are not checked per patch';
  }
  return (
    'per-patch checkJs roots only patch-created .sys.mjs modules and test scripts' +
    (file.endsWith('.mjs')
      ? '; this module is a resolution target for the test programs of its patch and later ones'
      : '')
  );
}

async function explainImports(
  source: string,
  resolvable: ReadonlySet<string>,
  engineDir: string,
  pathsMapping: Record<string, string[]> | undefined
): Promise<ExplainedImport[]> {
  const match = createOwnedPathMatcher(resolvable);
  const imports: ExplainedImport[] = [];
  for (const specifier of findUrlImports(source)) {
    const owned = match(specifier);
    if (owned !== undefined) {
      imports.push({ specifier, resolution: 'owned', target: owned });
      continue;
    }
    let viaPaths: string | undefined;
    for (const target of pathsMapping ? pathsTargetCandidates(pathsMapping, specifier) : []) {
      if (await pathExists(resolve(engineDir, target))) {
        viaPaths = target;
        break;
      }
    }
    imports.push(
      viaPaths !== undefined
        ? { specifier, resolution: 'paths', target: viaPaths }
        : { specifier, resolution: 'any' }
    );
  }
  return imports;
}

/** The files of `files` that exist under `engineDir`, sorted. */
async function existing(engineDir: string, files: Iterable<string>): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    if (await pathExists(resolve(engineDir, file))) kept.push(file);
  }
  return kept.sort();
}

async function explainPerPatch(
  paths: ProjectPaths,
  config: FireForgeConfig,
  absoluteFile: string,
  ctx: PatchQueueContext | undefined
): Promise<PerPatchExplanation> {
  const patchLint = config.patchLint ?? {};
  const base: PerPatchExplanation = {
    enabled: patchLint.checkJs === true,
    creators: [],
    modifiers: [],
    program: 'none',
    heads: [],
    resolvable: [],
    imports: [],
    litTypes: patchLint.litTypes === true,
    strict: patchLint.checkJsStrict === true,
    undefinedIdentifiers: patchLint.undefinedIdentifiers ?? 'warning',
  };
  const rel = normalizePathSlashes(relative(paths.engine, absoluteFile));
  if (rel.startsWith('..') || rel === '') {
    return { ...base, reason: 'it is outside engine/, where every per-patch program lives' };
  }
  base.engineFile = rel;
  if (!base.enabled) return { ...base, reason: 'patchLint.checkJs is off' };
  if (ctx === undefined) return { ...base, reason: 'the project has no patch queue' };

  const creators = collectNewFileCreatorsByPath(ctx).get(rel) ?? [];
  const modifiers = ctx.entries
    .filter((entry) => !creators.includes(entry.filename) && entry.modifiedFileAdditions.has(rel))
    .map((entry) => entry.filename);
  const known = { ...base, creators: [...creators], modifiers };
  const testFilesEnabled = patchLint.checkJsTestFiles === true;

  let program: PerPatchExplanation['program'] = 'none';
  let heads: string[] = [];
  let resolvable: string[] = [];
  if (creators.length > 0 && rel.endsWith('.sys.mjs')) {
    program = 'module';
    resolvable = [...resolvePatchOwnedSysMjs(new Set(), ctx)].filter((f) => f !== rel);
  } else if (creators.length > 0 && testFilesEnabled && isTestScriptFile(rel)) {
    program = 'test';
    const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
    heads = [...resolvePatchOwnedTestScripts(new Set(), ctx)].filter(
      (f) => f !== rel && f.startsWith(dir) && HEAD_SCRIPT.test(f.slice(f.lastIndexOf('/') + 1))
    );
    resolvable = [...resolvableModulesForTests(ctx)(rel)];
  }
  if (program === 'none') {
    return { ...known, reason: noProgramReason(rel, creators, modifiers, testFilesEnabled) };
  }

  const source = await readFile(absoluteFile, 'utf8').catch(() => '');
  // What the program is built over: only files that exist are resolvable,
  // and `paths` applies under `checkJsStrict`, as in the compiler host.
  const programHeads = await existing(paths.engine, heads);
  const programModules = await existing(paths.engine, resolvable);
  const pathsMapping =
    patchLint.checkJsStrict === true ? patchLint.checkJsCompilerOptions?.paths : undefined;
  const shim = program === 'test' ? patchLint.checkJsTestShim : patchLint.checkJsExtraShim;
  return {
    ...known,
    program,
    heads: programHeads,
    resolvable: programModules,
    imports: await explainImports(
      source,
      new Set([rel, ...programHeads, ...programModules]),
      paths.engine,
      pathsMapping
    ),
    ...(shim !== undefined ? { shim } : {}),
  };
}

/**
 * Explains how `fireforge typecheck` sees one file. Read-only: nothing is
 * checked, generated or cached.
 *
 * @param paths - The project's paths
 * @param config - Loaded `fireforge.json`
 * @param typecheck - The typecheck block in force (`--project` applied), if any
 * @param file - The file, relative to the project root, relative to
 *   `engine/`, or absolute
 */
export async function explainTypecheckFile(
  paths: ProjectPaths,
  config: FireForgeConfig,
  typecheck: TypecheckConfig | undefined,
  file: string
): Promise<TypecheckExplanation> {
  const fromRoot = resolve(paths.root, file);
  const fromEngine = resolve(paths.engine, file);
  const absoluteFile =
    !(await pathExists(fromRoot)) && (await pathExists(fromEngine)) ? fromEngine : fromRoot;
  const display = normalizePathSlashes(relative(paths.root, absoluteFile));

  let ts: typeof import('typescript') | undefined;
  try {
    ts = await import('typescript');
  } catch {
    ts = undefined;
  }
  const projects: ProjectExplanation[] = [];
  for (const project of typecheck?.projects ?? []) {
    projects.push(
      await explainProject(ts, paths.root, typecheck ?? { projects: [] }, project, absoluteFile)
    );
  }

  const ctx =
    config.patchLint?.checkJs === true && (await pathExists(paths.patches))
      ? await buildPatchQueueContext(paths.patches, config)
      : undefined;
  return {
    file: display.startsWith('..') ? normalizePathSlashes(absoluteFile) : display,
    exists: await pathExists(absoluteFile),
    projects,
    perPatch: await explainPerPatch(paths, config, absoluteFile, ctx),
  };
}
