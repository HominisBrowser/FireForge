// SPDX-License-Identifier: EUPL-1.2
/**
 * Strict typing of owned JavaScript (`patchLint.checkJs`).
 *
 * Programs are built in memory over the owned files' final content; the
 * engine is never read except for the targets of a reviewed `paths`
 * mapping. One program checks every created module (`.sys.mjs`); with
 * `checkJsTestFiles` each created test script is its own program with its
 * directory's created `head*.js` helpers, since mochitest scripts share
 * top-level scope only with those. Every program resolves `resource:` and
 * `chrome:` imports to the created module whose basename the specifier ends
 * with (`.mjs` also finding `.sys.mjs`), when exactly one matches; any other
 * URL import falls to the shim's wildcard modules and types as `any`.
 *
 * Each program's result is cached by the digests of everything it read
 * (see `cache.ts`), so an unchanged program is not rebuilt.
 */
import { posix } from 'node:path';

import type { PatchLintConfig } from '../config/index.js';
import { hash } from '../kernel/hash.js';
import { textContent } from '../project/index.js';
import { importSpecifiers } from '../syntax/index.js';
import { type CachedFinding, pruneCache, readCached, writeCached } from './cache.js';
import type { OwnedFiles } from './input.js';
import { basename, directoryOf, type Draft, type EngineReader, isTestFile } from './rule.js';
import {
  composeShim,
  judgeDiagnostic,
  loadTypeScript,
  type Shim,
  type TypeScript,
  withGeckoDomTypes,
} from './typescript.js';

/** Where owned files live inside a program: a root no real file can sit under. */
const ROOT = '/fireforge-engine/';

/** What {@link checkOwnedJs} reads. */
export interface CheckJsInput {
  readonly owned: OwnedFiles;
  readonly engine: EngineReader;
  readonly lint: PatchLintConfig;
  readonly projectRoot: string;
  readonly cacheDir: string | undefined;
  /** The run covers every owned file, so cache entries it does not use are dropped. */
  readonly complete: boolean;
  readonly selected: (path: string) => boolean;
}

/** One program: its roots, the files it reports on, and its shim. */
interface Unit {
  readonly roots: readonly string[];
  readonly report: ReadonlySet<string>;
  readonly shim: Shim;
}

/** Whether a path is a test script the test pass checks. */
function isTestScript(path: string): boolean {
  return path.endsWith('.js') && !path.endsWith('.sys.mjs') && isTestFile(path);
}

/** Whether a path is a test directory's `head.js` / `head_*.js` helper. */
function isHeadScript(path: string): boolean {
  return /^head(?:_.*)?\.js$/.test(basename(path));
}

/**
 * The created module a URL specifier resolves to: the one whose basename is
 * the specifier's last segment (`.mjs` also matching `.sys.mjs`). Relative,
 * ambiguous and unknown specifiers resolve to nothing.
 *
 * @param modules - The resolvable modules
 */
export function moduleMatcher(
  modules: Iterable<string>
): (specifier: string) => string | undefined {
  const byName = new Map<string, string[]>();
  for (const path of modules)
    byName.set(basename(path), [...(byName.get(basename(path)) ?? []), path]);
  return (specifier) => {
    if (specifier.startsWith('.')) return undefined;
    const name = basename(specifier.split(/[?#]/)[0] ?? specifier);
    if (name === '') return undefined;
    const candidates = [...(byName.get(name) ?? [])];
    if (name.endsWith('.mjs') && !name.endsWith('.sys.mjs')) {
      candidates.push(...(byName.get(name.replace(/\.mjs$/, '.sys.mjs')) ?? []));
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  };
}

/**
 * The engine paths a reviewed `paths` mapping offers for a specifier, in
 * the order tried: patterns as declared, each pattern's targets in order. A
 * pattern's one `*` captures text that replaces the target's one `*`.
 *
 * @param paths - `checkJsCompilerOptions.paths`
 * @param specifier - The import specifier
 */
export function pathsCandidates(
  paths: Readonly<Record<string, readonly string[]>>,
  specifier: string
): string[] {
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    let captured = '';
    if (star === -1) {
      if (specifier !== pattern) continue;
    } else {
      const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
      if (specifier.length < prefix.length + suffix.length) continue;
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of targets) {
      const at = target.indexOf('*');
      const path = at === -1 ? target : target.slice(0, at) + captured + target.slice(at + 1);
      candidates.push(posix.normalize(path).replace(/^\.\//, ''));
    }
  }
  return candidates;
}

const TYPE_IMPORT = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function specifiersOf(source: string): string[] {
  return [
    ...importSpecifiers(source).map((entry) => entry.specifier),
    ...[...source.matchAll(TYPE_IMPORT)].map((match) => match[1] ?? ''),
  ];
}

/** The program's in-memory files: owned content plus the `paths` targets it can reach. */
async function programFiles(
  input: CheckJsInput,
  sources: ReadonlyMap<string, string>,
  paths: Readonly<Record<string, readonly string[]>> | undefined
): Promise<{ files: Map<string, string>; mapped: Map<string, string> }> {
  const files = new Map(sources);
  const mapped = new Map<string, string>();
  if (paths === undefined) return { files, mapped };
  const queue = [...files.values()];
  for (let source = queue.pop(); source !== undefined; source = queue.pop()) {
    for (const specifier of specifiersOf(source)) {
      if (mapped.has(specifier)) continue;
      for (const candidate of pathsCandidates(paths, specifier)) {
        let text = files.get(candidate) ?? input.owned.get(candidate)?.text;
        if (text === undefined && !input.owned.deletes(candidate)) {
          const bytes = await input.engine.read(candidate);
          text = bytes === undefined ? undefined : textContent(bytes);
        }
        if (text === undefined) continue;
        mapped.set(specifier, candidate);
        if (!files.has(candidate)) {
          files.set(candidate, text);
          queue.push(text);
        }
        break;
      }
    }
  }
  return { files, mapped };
}

function compilerOptions(
  ts: TypeScript,
  lint: PatchLintConfig
): import('typescript').CompilerOptions {
  const strict = lint.checkJsStrict;
  const { paths, ...flags } = lint.checkJsCompilerOptions ?? {};
  return {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
    strict,
    noImplicitAny: strict,
    ...(strict ? flags : {}),
    ...(strict && paths !== undefined ? { paths } : {}),
  };
}

/** Implicit-`any` codes, which an unresolved URL import explains. */
const IMPLICIT_ANY = new Set([7005, 7006, 7008, 7010, 7011, 7019, 7031, 7034]);
const WILDCARD_MEMBER = /^Namespace '"([^"]*)"' has no exported member /;

interface Shared {
  readonly ts: TypeScript;
  readonly options: import('typescript').CompilerOptions;
  readonly files: ReadonlyMap<string, string>;
  readonly resolveModule: (specifier: string) => string | undefined;
  readonly parsed: Map<string, import('typescript').SourceFile>;
  readonly undefinedIdentifiers: 'off' | 'warning' | 'error';
}

/** The extension TypeScript is told a resolved file has. */
function extensionOf(ts: TypeScript, path: string): import('typescript').Extension {
  if (path.endsWith('.d.ts')) return ts.Extension.Dts;
  if (path.endsWith('.ts')) return ts.Extension.Ts;
  if (path.endsWith('.js')) return ts.Extension.Js;
  return ts.Extension.Mjs;
}

/** Builds one program and returns its findings on the unit's report files. */
function runUnit(shared: Shared, unit: Unit): { findings: CachedFinding[]; read: string[] } {
  const { ts, options, files } = shared;
  const shimPath = ROOT + unit.shim.fileName;
  const unresolved = new Map<string, Set<string>>();
  const resolved = new Map<string, Set<string>>();
  const note = (into: Map<string, Set<string>>, file: string, specifier: string): void => {
    into.set(file, new Set([...(into.get(file) ?? []), specifier]));
  };
  const base = withGeckoDomTypes(ts, ts.createCompilerHost(options));
  const memoryText = (fileName: string): string | undefined =>
    fileName === shimPath
      ? unit.shim.source
      : fileName.startsWith(ROOT)
        ? files.get(fileName.slice(ROOT.length))
        : undefined;
  const host: import('typescript').CompilerHost = {
    ...base,
    getCurrentDirectory: () => ROOT,
    getSourceFile(fileName, languageVersion, onError) {
      const key = `${fileName}\0${typeof languageVersion === 'object' ? languageVersion.languageVersion : languageVersion}`;
      const cached = shared.parsed.get(key);
      if (cached !== undefined) return cached;
      const text = memoryText(fileName);
      const file =
        text !== undefined
          ? ts.createSourceFile(fileName, text, languageVersion, true)
          : fileName.startsWith(ROOT)
            ? ts.createSourceFile(fileName, '', languageVersion, true)
            : base.getSourceFile(fileName, languageVersion, onError);
      if (file !== undefined) shared.parsed.set(key, file);
      return file;
    },
    fileExists: (fileName) =>
      memoryText(fileName) !== undefined ||
      (!fileName.startsWith(ROOT) && base.fileExists(fileName)),
    readFile: (fileName) =>
      memoryText(fileName) ?? (fileName.startsWith(ROOT) ? undefined : base.readFile(fileName)),
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => {
        const target = shared.resolveModule(literal.text);
        if (target === undefined) {
          if (/^(?:resource|chrome):/.test(literal.text))
            note(unresolved, containingFile, literal.text);
          return { resolvedModule: undefined };
        }
        note(resolved, containingFile, literal.text);
        return {
          resolvedModule: {
            resolvedFileName: ROOT + target,
            extension: extensionOf(ts, target),
            isExternalLibraryImport: false,
          },
        };
      }),
  };
  const program = ts.createProgram(
    [...unit.roots.map((root) => ROOT + root), shimPath],
    options,
    host
  );
  const findings: CachedFinding[] = [];
  for (const file of program.getSourceFiles()) {
    const path = file.fileName.startsWith(ROOT) ? file.fileName.slice(ROOT.length) : undefined;
    if (path === undefined || !unit.report.has(path)) continue;
    const anyTyped = unresolved.get(file.fileName);
    for (const diagnostic of [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]) {
      const judged = judgeDiagnostic(ts, diagnostic, {
        undefinedIdentifiers: shared.undefinedIdentifiers,
        isResolved: (containing, specifier) => resolved.get(containing)?.has(specifier) === true,
      });
      if (judged === undefined) continue;
      const member = judged.code === 2694 ? WILDCARD_MEMBER.exec(judged.message)?.[1] : undefined;
      if (
        member !== undefined &&
        (member === 'resource:*' || member === 'chrome:*' || anyTyped?.has(member) === true)
      ) {
        continue;
      }
      const hint =
        IMPLICIT_ANY.has(judged.code) && anyTyped !== undefined
          ? ` (${[...anyTyped].sort().join(', ')} resolves to no owned module here, so it types as any; annotate explicitly.)`
          : '';
      findings.push({
        path,
        line: file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
        severity: judged.severity,
        message: `TS${judged.code}: ${judged.message}${hint}`,
      });
    }
  }
  const read = program
    .getSourceFiles()
    .flatMap((file) =>
      file.fileName.startsWith(ROOT) && files.has(file.fileName.slice(ROOT.length))
        ? [file.fileName.slice(ROOT.length)]
        : []
    );
  return { findings, read };
}

/** The programs to run: the module program, then one per test script. */
async function plan(
  input: CheckJsInput
): Promise<{ units: Unit[]; modules: string[]; sources: Map<string, string> }> {
  const created = input.owned.all().filter((file) => file.created && file.text !== undefined);
  const sources = new Map(created.map((file) => [file.path, file.text ?? '']));
  const modules = created
    .map((file) => file.path)
    .filter((path) => path.endsWith('.mjs') && !isTestScript(path));
  const roots = modules.filter((path) => path.endsWith('.sys.mjs') && input.selected(path));
  const units: Unit[] = [];
  const litTypes = input.lint.litTypes;
  if (roots.length > 0) {
    const shim = await composeShim(input.projectRoot, input.lint.checkJsExtraShim, { litTypes });
    units.push({ roots, report: new Set(roots), shim });
  }
  if (input.lint.checkJsTestFiles) {
    const paths = created.map((file) => file.path);
    const heads = paths.filter(isHeadScript);
    const selected = paths.filter(
      (path) => isTestScript(path) && !isHeadScript(path) && input.selected(path)
    );
    if (selected.length > 0) {
      const shim = await composeShim(input.projectRoot, input.lint.checkJsTestShim, {
        litTypes,
        testHarness: true,
      });
      for (const test of selected.sort()) {
        const own = heads.filter((head) => directoryOf(head) === directoryOf(test));
        units.push({ roots: [test, ...own], report: new Set([test]), shim });
      }
    }
  }
  return { units, modules, sources };
}

/**
 * Type-checks the created modules and, with `checkJsTestFiles`, the created
 * test scripts. Findings carry the path and line they are on.
 *
 * @param input - See {@link CheckJsInput}
 * @throws FireForgeError when TypeScript is not installed or a configured shim is missing
 */
export async function checkOwnedJs(input: CheckJsInput): Promise<Draft[]> {
  const { units, modules, sources } = await plan(input);
  if (units.length === 0) return [];
  const ts = await loadTypeScript();
  const options = compilerOptions(ts, input.lint);
  const { files, mapped } = await programFiles(input, sources, options.paths);
  const matchModule = moduleMatcher(modules);
  const shared: Shared = {
    ts,
    options,
    files,
    resolveModule: (specifier) => matchModule(specifier) ?? mapped.get(specifier),
    parsed: new Map(),
    undefinedIdentifiers: input.lint.undefinedIdentifiers,
  };
  const digests = new Map([...files].map(([path, text]) => [path, hash(text)]));
  const drafts: Draft[] = [];
  const used = new Set<string>();
  for (const unit of units) {
    const key = hash(
      JSON.stringify([
        ts.version,
        unit.roots,
        [...unit.report],
        unit.shim.fileName,
        options,
        modules,
        [...mapped],
        input.lint.undefinedIdentifiers,
      ])
    );
    used.add(key);
    let findings = await readCached(input.cacheDir, key, digests);
    if (findings === undefined) {
      const result = runUnit(shared, unit);
      findings = result.findings;
      await writeCached(input.cacheDir, key, result.read, digests, findings);
    }
    drafts.push(
      ...findings.map((finding) => ({
        path: finding.path,
        line: finding.line,
        severity: finding.severity,
        message: finding.message,
        group: input.owned.get(finding.path)?.group,
      }))
    );
  }
  if (input.complete && input.cacheDir !== undefined) await pruneCache(input.cacheDir, used);
  return drafts;
}

/** How the strict owned pass sees one file. */
export interface OwnedTypesView {
  /** `module`: a root of the module program; `test`: the root of its own program; `none`: not checked. */
  readonly program: 'module' | 'test' | 'none';
  /** Why no program checks it. */
  readonly reason?: string;
  /** For a test: the head helpers its program loads beside it. */
  readonly heads: readonly string[];
  /** The file's URL imports and what each resolves to: an owned module, a `paths` target, or `any`. */
  readonly imports: readonly OwnedImport[];
  /** The project shim the program appends. */
  readonly shim?: string;
}

/** One URL import of a file and what the strict owned pass resolves it to. */
export interface OwnedImport {
  readonly specifier: string;
  readonly resolution: 'owned' | 'paths' | 'any';
  readonly target?: string;
}

function noneReason(input: CheckJsInput, path: string): string | undefined {
  const file = input.owned.get(path);
  if (!input.lint.checkJs) return 'patchLint.checkJs is off';
  if (file === undefined) return 'the project does not own this file';
  if (!file.created)
    return 'the project modifies this upstream file; only files it creates are checked';
  if (isHeadScript(path)) {
    return 'it is a head helper, checked inside each test program of its directory';
  }
  if (isTestScript(path)) {
    return input.lint.checkJsTestFiles
      ? undefined
      : 'it is a test script and patchLint.checkJsTestFiles is off';
  }
  return path.endsWith('.sys.mjs')
    ? undefined
    : 'only created .sys.mjs modules and test scripts are checked';
}

/**
 * How the strict owned pass sees one file, without checking anything.
 *
 * @param input - See {@link CheckJsInput}
 * @param path - Engine-relative path
 */
export async function explainOwnedJs(input: CheckJsInput, path: string): Promise<OwnedTypesView> {
  const text = input.owned.get(path)?.text ?? '';
  const { modules, sources } = await plan({ ...input, selected: () => false });
  const paths = input.lint.checkJsStrict ? input.lint.checkJsCompilerOptions?.paths : undefined;
  const { mapped } = await programFiles(input, new Map([...sources, [path, text]]), paths);
  const match = moduleMatcher(modules);
  const imports = [...new Set(specifiersOf(text).filter((s) => /^(?:resource|chrome):/.test(s)))]
    .sort()
    .map((specifier): OwnedImport => {
      const owned = match(specifier);
      if (owned !== undefined) return { specifier, resolution: 'owned', target: owned };
      const target = mapped.get(specifier);
      return target === undefined
        ? { specifier, resolution: 'any' }
        : { specifier, resolution: 'paths', target };
    });
  const reason = noneReason(input, path);
  if (reason !== undefined) return { program: 'none', reason, heads: [], imports };
  const test = isTestScript(path);
  const heads = test
    ? input.owned
        .all()
        .map((file) => file.path)
        .filter(
          (other) =>
            other !== path && isHeadScript(other) && directoryOf(other) === directoryOf(path)
        )
    : [];
  const shim = test ? input.lint.checkJsTestShim : input.lint.checkJsExtraShim;
  return {
    program: test ? 'test' : 'module',
    heads,
    imports,
    ...(shim === undefined ? {} : { shim }),
  };
}
