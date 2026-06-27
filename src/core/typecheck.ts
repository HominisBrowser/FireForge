// SPDX-License-Identifier: EUPL-1.2
/**
 * Whole-project TypeScript type checking driven by user-supplied
 * `jsconfig.json` paths. The engine behind the `fireforge typecheck`
 * command.
 *
 * Distinct from `patch-lint-checkjs.ts` (patch-hygiene): patchLint is
 * scoped, fireforge-controlled, and runs as part of `fireforge lint`;
 * this command runs whole projects with user-controlled compiler
 * options and is intended as a CI gate. The two share the Firefox
 * globals shim and suppressed-code list (via `typecheck-shim.ts`) so
 * a file that lints clean cannot fail typecheck for a reason the
 * operator could not have inferred from the docs.
 *
 * Loads the TypeScript compiler API via dynamic import so it is only
 * required when `typecheck.projects` is configured. TypeScript
 * remains a dev-dependency — if a user invokes `fireforge typecheck`
 * without installing it, the function returns a clear error pointing
 * at `npm install typescript`.
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { TypecheckConfig } from '../types/config.js';
import type { TypecheckIssue, TypecheckProjectResult } from '../types/typecheck.js';
import { pathExists } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { composeShimSource, SHIM_FILENAME, SUPPRESSED_DIAGNOSTIC_CODES } from './typecheck-shim.js';

/**
 * Sentinel string surfaced as a `TypecheckIssue.message` when the
 * project's jsconfig sets `checkJs: false`. Exported so tests can
 * pin the contract — operators rely on it to spot opted-out projects
 * in CI logs.
 */
export const CHECK_JS_DISABLED_NOTICE =
  'Project sets "checkJs: false" — skipping (override the jsconfig to enable typecheck).';

/**
 * Runs `fireforge typecheck` against every project listed in `cfg.projects`.
 *
 * Per-project flow:
 *   1. Read the jsconfig via the TS API. JSON parse / config-spec
 *      errors are surfaced as issues, not thrown — a single broken
 *      project must not abort the rest of the run.
 *   2. Compute final compiler options from the user's options. We
 *      only force `noEmit: true` (this is a typecheck, not a build);
 *      we honour `strict`, `target`, `lib`, `module`, `paths`,
 *      `include`, `exclude`. `allowJs` and `checkJs` default to
 *      `true` only when the user has not set them — if the user set
 *      `checkJs: false` we treat that as an explicit opt-out and
 *      skip the project with a single notice (see {@link CHECK_JS_DISABLED_NOTICE}).
 *   3. Inject the synthetic shim (built-in + optional extraShim) as
 *      a virtual root file that the custom CompilerHost serves.
 *   4. Build the program; collect semantic, syntactic, options, and
 *      global diagnostics. The patchLint flow only reads semantic +
 *      syntactic — fine for hygiene, but a CI gate needs the full
 *      set so misconfigured `lib`/`paths` entries fail loudly.
 *   5. Drop diagnostics whose code is in `SUPPRESSED_DIAGNOSTIC_CODES`
 *      and any diagnostic originating in the synthetic shim itself.
 *
 * @param projectRoot - Absolute project root. All paths in `cfg` are resolved against it.
 * @param cfg - Validated `typecheck` block from `fireforge.json`.
 * @returns One {@link TypecheckProjectResult} per entry in `cfg.projects`,
 *   in declared order. The CLI is responsible for printing the issues
 *   and computing the exit code.
 */
export async function runTypecheck(
  projectRoot: string,
  cfg: TypecheckConfig
): Promise<TypecheckProjectResult[]> {
  // Dynamic import — typescript stays a dev dependency. Same pattern
  // as `patch-lint-checkjs.ts`; the empty-projects-array case is
  // already rejected by config-validate, so we don't gate the import
  // on `cfg.projects.length`.
  let ts: typeof import('typescript');
  try {
    ts = await import('typescript');
  } catch {
    return cfg.projects.map((project) => ({
      project,
      issues: [
        {
          file: '(typecheck)',
          line: 1,
          column: 1,
          code: 0,
          category: 'error' as const,
          message:
            'fireforge typecheck requires the "typescript" package. Run "npm install typescript" to enable type checking.',
          project,
        },
      ],
      filesChecked: 0,
    }));
  }

  // Compose the shim PER project: the effective extraShim is the per-project
  // override (a path, or `null` to opt out) when present, else the shared
  // top-level extraShim. A project that narrows `lib`/`types` can opt out of
  // a Gecko-lib shim hub that another project needs, so the composed shim is
  // no longer injected identically everywhere. Compositions are cached by the
  // resolved extraShim path so projects sharing a shim don't recompose it.
  const shimCache = new Map<string, string>();
  const composeForProject = async (extraShim: string | undefined): Promise<string> => {
    const key = extraShim ?? '';
    const cached = shimCache.get(key);
    if (cached !== undefined) return cached;
    const composed = await composeShimSource(projectRoot, extraShim);
    if (composed.extraShimAppended) {
      verbose(`typecheck: extra shim ${extraShim ?? ''} appended to Firefox globals shim`);
    }
    shimCache.set(key, composed.source);
    return composed.source;
  };

  const results: TypecheckProjectResult[] = [];
  for (const projectPath of cfg.projects) {
    const extraShim = resolveProjectExtraShim(cfg, projectPath);
    let shimSource: string;
    try {
      shimSource = await composeForProject(extraShim);
    } catch (err) {
      // A missing or unreadable shim fails only the project(s) that use it,
      // not the whole run — projects with a different (or no) shim still run.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        project: projectPath,
        issues: [
          {
            file: extraShim ?? '(typecheck)',
            line: 1,
            column: 1,
            code: 0,
            category: 'error',
            message,
            project: projectPath,
          },
        ],
        filesChecked: 0,
      });
      continue;
    }
    results.push(await runTypecheckForProject(ts, projectRoot, projectPath, shimSource));
  }
  return results;
}

/**
 * Resolves the effective extra shim for a single project: a `projectOverrides`
 * entry wins (a string path overrides; `null` opts out → `undefined`), else
 * the shared top-level `extraShim` applies.
 */
function resolveProjectExtraShim(cfg: TypecheckConfig, projectPath: string): string | undefined {
  const overrides = cfg.projectOverrides;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, projectPath)) {
    const value = overrides[projectPath];
    return value === null ? undefined : value;
  }
  return cfg.extraShim;
}

/** Runs typecheck for a single jsconfig path, isolating its failures. */
async function runTypecheckForProject(
  ts: typeof import('typescript'),
  projectRoot: string,
  projectPath: string,
  shimSource: string
): Promise<TypecheckProjectResult> {
  const absConfig = resolve(projectRoot, projectPath);
  if (!(await pathExists(absConfig))) {
    return {
      project: projectPath,
      issues: [
        {
          file: projectPath,
          line: 1,
          column: 1,
          code: 0,
          category: 'error',
          message: `jsconfig.json not found: ${projectPath} (resolved to ${absConfig})`,
          project: projectPath,
        },
      ],
      filesChecked: 0,
    };
  }

  // 1) Read the JSON config. ts.readConfigFile reports JSON-shape
  // errors via the returned diagnostic; missing files fall back to
  // pathExists above, which gives a more directly actionable message.
  const readResult = ts.readConfigFile(absConfig, (path) => ts.sys.readFile(path));
  if (readResult.error) {
    return {
      project: projectPath,
      issues: [diagnosticToIssue(ts, readResult.error, projectPath, projectPath)],
      filesChecked: 0,
    };
  }

  // 2) Parse the config content. This is what surfaces config-spec
  // errors (unknown options, mismatched types in `compilerOptions`,
  // bad `include` patterns, etc.) — TS5xxx codes. We surface them
  // alongside semantic diagnostics so the operator sees the same
  // output `tsc -p` would have produced.
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    dirname(absConfig),
    /* existingOptions */ undefined,
    absConfig
  );
  const issues: TypecheckIssue[] = [];
  for (const diag of parsed.errors) {
    if (SUPPRESSED_DIAGNOSTIC_CODES.has(diag.code)) continue;
    issues.push(diagnosticToIssue(ts, diag, absConfig, projectPath));
  }

  // 3) Honour explicit `checkJs: false`. The user has opted out for
  // an IDE reason (likely "checkJs floods my workflow with non-actionable
  // notes"); flipping it on here would surface ~hundreds of issues that
  // the operator already evaluated and rejected. Surface a single
  // notice so it is visible in CI logs rather than silently passing.
  const rawConfig = readResult.config as { compilerOptions?: Record<string, unknown> } | undefined;
  if (rawConfig?.compilerOptions?.['checkJs'] === false) {
    issues.push({
      file: projectPath,
      line: 1,
      column: 1,
      code: 0,
      category: 'warning',
      message: CHECK_JS_DISABLED_NOTICE,
      project: projectPath,
    });
    return { project: projectPath, issues, filesChecked: parsed.fileNames.length };
  }

  // 4) Compute final compiler options. `noEmit: true` is forced — we
  // never write artifacts. `allowJs` / `checkJs` default to true
  // *only* when unset (so a user can flip them off without us
  // overriding); if the user set `allowJs: false` they're saying
  // "don't even include JS in this typecheck", which is rare but
  // legitimate (e.g. an isolated `.d.ts`-only project).
  const options: import('typescript').CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    allowJs: parsed.options.allowJs ?? true,
    checkJs: parsed.options.checkJs ?? true,
    // skipLibCheck is not forced; the user owns it via their jsconfig.
  };

  // 5) The synthetic shim file. Use a project-rooted path with a
  // hidden-style prefix so it is unlikely to collide with any real
  // file — and never write it to disk. The CompilerHost below serves
  // it from `shimSource` for `fileExists`/`readFile`/`getSourceFile`.
  const projectDir = dirname(absConfig);
  const shimPath = resolve(projectDir, `.fireforge-${SHIM_FILENAME}`);

  const rootFiles = [...parsed.fileNames, shimPath];
  const defaultHost = ts.createCompilerHost(options);
  const host: import('typescript').CompilerHost = {
    ...defaultHost,
    getSourceFile(fileName, languageVersion, onError, shouldCreate) {
      if (fileName === shimPath) {
        return ts.createSourceFile(fileName, shimSource, languageVersion, true);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
    fileExists(fileName) {
      if (fileName === shimPath) return true;
      return defaultHost.fileExists(fileName);
    },
    readFile(fileName) {
      if (fileName === shimPath) return shimSource;
      return defaultHost.readFile(fileName);
    },
  };

  const program = ts.createProgram(rootFiles, options, host);

  // Collect the full diagnostic set. patchLint reads only semantic +
  // syntactic — fine for hygiene, wrong for CI: a misconfigured
  // `lib: ["es2015"]` or a missing `paths` target should fail
  // typecheck loudly via getOptionsDiagnostics / getGlobalDiagnostics.
  const allDiagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  for (const diag of allDiagnostics) {
    if (SUPPRESSED_DIAGNOSTIC_CODES.has(diag.code)) continue;
    // Drop diagnostics that originate in the synthetic shim — operators
    // can't act on them and they would clutter CI logs.
    if (diag.file?.fileName === shimPath) continue;
    issues.push(diagnosticToIssue(ts, diag, absConfig, projectPath));
  }

  verbose(
    `typecheck: ${projectPath} — analyzed ${String(parsed.fileNames.length)} file(s), found ${String(issues.length)} issue(s)`
  );

  return {
    project: projectPath,
    issues,
    filesChecked: parsed.fileNames.length,
  };
}

/**
 * Converts a TS Diagnostic to a TypecheckIssue. The `fallbackFile`
 * is used when the diagnostic carries no source file (typical for
 * options diagnostics) — typically the absolute jsconfig path or
 * the project-relative form for surface-level errors. `project` is
 * threaded through so the CLI can group issues by project without
 * a second pass.
 */
function diagnosticToIssue(
  ts: typeof import('typescript'),
  diag: import('typescript').Diagnostic,
  fallbackFile: string,
  project: string
): TypecheckIssue {
  let file = fallbackFile;
  let line = 1;
  let column = 1;
  if (diag.file) {
    file = diag.file.fileName;
    if (typeof diag.start === 'number') {
      const lc = diag.file.getLineAndCharacterOfPosition(diag.start);
      line = lc.line + 1;
      column = lc.character + 1;
    }
  }
  const message =
    typeof diag.messageText === 'string'
      ? diag.messageText
      : ts.flattenDiagnosticMessageText(diag.messageText, '\n');

  // Suggestion + Message categories collapse to 'warning'; only
  // Error stays an error. This matches what the CLI then displays.
  const category: TypecheckIssue['category'] =
    diag.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';

  return {
    file,
    line,
    column,
    code: diag.code,
    category,
    message,
    project,
  };
}

/**
 * Converts an absolute path to a path relative to the project root,
 * for display in CLI output. Falls back to the absolute path when
 * the path lies outside the root (e.g. a `node_modules` symlinked
 * from elsewhere). Exposed for tests and the CLI.
 */
export function relativeForDisplay(projectRoot: string, absoluteFile: string): string {
  if (!isAbsolute(absoluteFile)) return absoluteFile;
  const rel = relative(projectRoot, absoluteFile);
  if (rel === '' || rel.startsWith('..')) return absoluteFile;
  return rel;
}
