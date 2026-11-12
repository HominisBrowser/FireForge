// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge typecheck`: the configured jsconfig projects, each checked
 * whole with its own compiler options and the Firefox-globals shim, plus
 * the strict typing of the owned files that `lint` runs. One command, one
 * result: a run is green only when both are.
 *
 * A project path is project-relative; one under `engine/` names the file in
 * the workspace's engine, so the same configuration serves a project whose
 * engine is its own `engine/` and one whose engine is a leased workspace.
 */
import { dirname, isAbsolute, join, relative } from 'node:path';

import type { FireForgeConfig, TypecheckConfig } from '../config/index.js';
import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import {
  ensureDir,
  exists,
  isInside,
  listDir,
  readLink,
  remove,
  toPosixPath,
  writeLink,
} from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import type { JsonObject } from '../kernel/json.js';
import {
  checkOwnedTypes,
  composeShim,
  type EngineReader,
  type Finding,
  judgeDiagnostic,
  loadTypeScript,
  type Shim,
  type TypeScript,
  withGeckoDomTypes,
} from '../lint/index.js';
import { type ChangeSet, configuredPath, projectPaths } from '../project/index.js';

/** What a typecheck run reads. */
export interface TypecheckRequest {
  readonly config: FireForgeConfig;
  readonly projectRoot: string;
  /** The workspace's engine directory, which `engine/` project paths name. */
  readonly engineDir: string;
  /** The owned changes, for the strict pass. */
  readonly changes: ChangeSet;
  readonly engine: EngineReader;
  /** Directory of the TypeScript result cache of the strict pass. */
  readonly cacheDir?: string;
  /** Projects to check instead of `typecheck.projects`, with the block's other settings. */
  readonly projects?: readonly string[];
}

/** One diagnostic of a project. */
export interface TypecheckIssue {
  /** Project-relative, `engine/…` for a file in the engine, or absolute outside both. */
  readonly path: string;
  readonly line: number;
  readonly column: number;
  /** The TypeScript code, 0 for FireForge's own findings about the project. */
  readonly code: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** One project's result. */
export interface ProjectResult {
  /** The project as configured. */
  readonly project: string;
  readonly filesChecked: number;
  readonly issues: readonly TypecheckIssue[];
}

/** The result of a run. */
export interface TypecheckReport {
  readonly projects: readonly ProjectResult[];
  /** Findings of the strict pass over the owned files. */
  readonly owned: readonly Finding[];
}

/** The projects of a run and the settings they share. */
export function projectsOf(request: TypecheckRequest): {
  projects: readonly string[];
  settings: Omit<TypecheckConfig, 'projects'> | undefined;
} {
  const configured = request.config.typecheck;
  return { projects: request.projects ?? configured?.projects ?? [], settings: configured };
}

/**
 * The directory a run's projects are read in: the project's files with the
 * engine at `engine/`. Project files name engine files, and engine files
 * name project files, by relative paths that assume this layout (the paths
 * Furnace writes into a jsconfig among them).
 *
 * A patch-mode project is that layout. For a workspace elsewhere, it is a
 * directory of links under the project's state directory: `engine` to the
 * workspace's engine, and one link per entry of the project directory.
 *
 * @param request - The project directory and the engine
 */
export async function projectLayout(
  request: Pick<TypecheckRequest, 'projectRoot' | 'engineDir'>
): Promise<string> {
  const { projectRoot, engineDir } = request;
  if (join(projectRoot, 'engine') === join(engineDir)) return projectRoot;
  const { stateDir } = projectPaths(projectRoot);
  const view = join(stateDir, 'view', hash(engineDir).slice(0, 16));
  const wanted = new Map<string, string>([['engine', engineDir]]);
  for (const entry of await listDir(projectRoot)) {
    if (entry.name === 'engine' || join(projectRoot, entry.name) === stateDir) continue;
    wanted.set(entry.name, join(projectRoot, entry.name));
  }
  await ensureDir(view);
  for (const entry of await listDir(view)) {
    if (!wanted.has(entry.name)) await remove(join(view, entry.name));
  }
  for (const [name, target] of wanted) {
    const link = join(view, name);
    const current = await readLink(link).catch(() => undefined);
    if (current !== target) await writeLink(link, target);
  }
  return view;
}

/**
 * The absolute path of a configured project path inside a layout:
 * `engine/…` names the engine, anything else a project file.
 *
 * @param layout - From {@link projectLayout}
 * @param path - A path as configured or typed
 */
export function resolveProjectPath(layout: string, path: string): string {
  if (isAbsolute(path)) return path;
  const named = configuredPath(path);
  return named.tree === 'engine' ? join(layout, 'engine', named.path) : join(layout, named.path);
}

/**
 * A file as reports name it: project-relative, `engine/…` for a file in
 * the engine, or absolute outside both.
 *
 * @param request - The project directory and the engine
 * @param layout - From {@link projectLayout}
 * @param file - An absolute path
 */
export function displayPath(
  request: Pick<TypecheckRequest, 'projectRoot' | 'engineDir'>,
  layout: string,
  file: string
): string {
  if (isInside(layout, file)) return toPosixPath(relative(layout, file));
  if (isInside(request.engineDir, file)) {
    return `engine/${toPosixPath(relative(request.engineDir, file))}`;
  }
  if (isInside(request.projectRoot, file)) return toPosixPath(relative(request.projectRoot, file));
  return file;
}

/**
 * The project shim a project uses: its `projectOverrides` entry (a path, or
 * null for none) when it has one, else `extraShim`.
 *
 * @param settings - The `typecheck` block
 * @param project - The project as configured or given
 */
export function projectShim(
  settings: Omit<TypecheckConfig, 'projects'> | undefined,
  project: string
): string | undefined {
  const overrides = settings?.projectOverrides ?? {};
  const key = Object.keys(overrides).find(
    (candidate) => candidate.replace(/^\.\//, '') === project.replace(/^\.\//, '')
  );
  if (key !== undefined) return overrides[key] ?? undefined;
  return settings?.extraShim;
}

function fileIssue(
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error'
): TypecheckIssue {
  return { path, line: 1, column: 1, code: 0, severity, message };
}

interface ProjectRun {
  readonly ts: TypeScript;
  readonly request: TypecheckRequest;
  readonly layout: string;
  readonly project: string;
  readonly shim: Shim;
  readonly undefinedIdentifiers: 'off' | 'warning' | 'error';
}

function diagnosticIssue(
  run: ProjectRun,
  diagnostic: import('typescript').Diagnostic,
  judged: { severity: 'error' | 'warning'; message: string },
  configFile: string
): TypecheckIssue {
  const file = diagnostic.file;
  const position =
    file === undefined || diagnostic.start === undefined
      ? { line: 0, character: 0 }
      : file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    path: displayPath(run.request, run.layout, file?.fileName ?? configFile),
    line: position.line + 1,
    column: position.character + 1,
    code: diagnostic.code,
    severity: judged.severity,
    message: judged.message,
  };
}

/** Reads and parses a project's jsconfig, or explains why it cannot be. */
export function parseProject(
  ts: TypeScript,
  configFile: string
):
  | { parsed: import('typescript').ParsedCommandLine; raw: unknown }
  | { problem: import('typescript').Diagnostic } {
  const read = ts.readConfigFile(configFile, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) return { problem: read.error };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configFile),
    undefined,
    configFile
  );
  return { parsed, raw: read.config };
}

/** Whether a jsconfig turns checkJs off explicitly, which skips the project. */
export function optsOut(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || !('compilerOptions' in raw)) return false;
  const options = raw.compilerOptions;
  return (
    typeof options === 'object' &&
    options !== null &&
    'checkJs' in options &&
    options.checkJs === false
  );
}

function checkProject(run: ProjectRun, configFile: string): ProjectResult {
  const { ts, project } = run;
  const read = parseProject(ts, configFile);
  if ('problem' in read) {
    const judged = {
      severity: 'error' as const,
      message: ts.flattenDiagnosticMessageText(read.problem.messageText, '\n'),
    };
    return {
      project,
      filesChecked: 0,
      issues: [diagnosticIssue(run, read.problem, judged, configFile)],
    };
  }
  const { parsed, raw } = read;
  const issues: TypecheckIssue[] = [];
  const shimPath = join(dirname(configFile), `.fireforge-${run.shim.fileName}`).replaceAll(
    '\\',
    '/'
  );

  const keep = (
    diagnostic: import('typescript').Diagnostic,
    isResolved: (file: string, specifier: string) => boolean
  ): void => {
    if (diagnostic.file?.fileName === shimPath) return;
    const judged = judgeDiagnostic(ts, diagnostic, {
      undefinedIdentifiers: run.undefinedIdentifiers,
      isResolved,
    });
    if (judged !== undefined) issues.push(diagnosticIssue(run, diagnostic, judged, configFile));
  };
  for (const diagnostic of parsed.errors) keep(diagnostic, () => false);
  if (optsOut(raw)) {
    issues.push(
      fileIssue(project, 'The project sets "checkJs": false, so it was skipped.', 'warning')
    );
    return { project, filesChecked: parsed.fileNames.length, issues };
  }
  const options: import('typescript').CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    allowJs: parsed.options.allowJs ?? true,
    checkJs: parsed.options.checkJs ?? true,
    incremental: false,
  };
  delete options.tsBuildInfoFile;
  const base = withGeckoDomTypes(ts, ts.createCompilerHost(options));
  const host: import('typescript').CompilerHost = {
    ...base,
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) =>
      fileName === shimPath
        ? ts.createSourceFile(fileName, run.shim.source, languageVersion, true)
        : base.getSourceFile(fileName, languageVersion, onError, shouldCreate),
    fileExists: (fileName) => fileName === shimPath || base.fileExists(fileName),
    readFile: (fileName) => (fileName === shimPath ? run.shim.source : base.readFile(fileName)),
    // Files keep the names the layout gives them, links included.
    realpath: (fileName) => fileName,
  };
  const program = ts.createProgram([...parsed.fileNames, shimPath], options, host);
  const resolved = new Map<string, boolean>();
  const isResolved = (file: string, specifier: string): boolean => {
    const key = `${file}\0${specifier}`;
    let hit = resolved.get(key);
    if (hit === undefined) {
      hit = ts.resolveModuleName(specifier, file, options, host).resolvedModule !== undefined;
      resolved.set(key, hit);
    }
    return hit;
  };
  for (const diagnostic of [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]) {
    keep(diagnostic, isResolved);
  }
  return { project, filesChecked: parsed.fileNames.length, issues };
}

/**
 * Runs the configured projects and the strict pass over the owned files.
 *
 * @param request - See {@link TypecheckRequest}
 * @throws FireForgeError `typecheck-unconfigured` when there is nothing to
 *   check, `typescript-missing` when the compiler API is not installed
 */
export async function runTypecheck(request: TypecheckRequest): Promise<TypecheckReport> {
  const { projects, settings } = projectsOf(request);
  if (projects.length === 0 && !request.config.patchLint.checkJs) {
    throw new FireForgeError('typecheck-unconfigured', 'There is nothing to type-check.', {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Configure "typecheck.projects" or "patchLint.checkJs" in fireforge.json, or pass --project.',
    });
  }
  const results: ProjectResult[] = [];
  if (projects.length > 0) {
    const ts = await loadTypeScript();
    const layout = await projectLayout(request);
    for (const project of projects) {
      const configFile = resolveProjectPath(layout, project);
      if (!(await exists(configFile))) {
        results.push({
          project,
          filesChecked: 0,
          issues: [fileIssue(project, `The project file ${project} does not exist.`)],
        });
        continue;
      }
      let shim: Shim;
      try {
        shim = await composeShim(request.projectRoot, projectShim(settings, project), {
          litTypes: settings?.litTypes ?? false,
        });
      } catch (error) {
        results.push({
          project,
          filesChecked: 0,
          issues: [fileIssue(project, toError(error).message)],
        });
        continue;
      }
      results.push(
        checkProject(
          {
            ts,
            request,
            layout,
            project,
            shim,
            undefinedIdentifiers: settings?.undefinedIdentifiers ?? 'warning',
          },
          configFile
        )
      );
    }
  }
  const owned = await checkOwnedTypes(request.changes, request.engine, request.config, {
    projectRoot: request.projectRoot,
    ...(request.cacheDir === undefined ? {} : { cacheDir: request.cacheDir }),
  });
  return { projects: results, owned };
}

/** Counts and the judgement of a report: any error fails, warnings do not. */
export function typecheckVerdict(report: TypecheckReport): {
  pass: boolean;
  errors: number;
  warnings: number;
} {
  const severities = [
    ...report.projects.flatMap((result) => result.issues.map((issue) => issue.severity)),
    ...report.owned.map((finding) => finding.severity),
  ];
  const errors = severities.filter((severity) => severity === 'error').length;
  return {
    pass: errors === 0,
    errors,
    warnings: severities.filter((severity) => severity === 'warning').length,
  };
}

/**
 * Human lines: `[<project>] <path>:<line>:<column> TS<code> <message>`, as
 * `tsc --pretty false` writes them, then the strict pass, then a summary.
 *
 * @param report - The report
 */
export function renderTypecheckReport(report: TypecheckReport): string[] {
  const lines: string[] = [];
  for (const result of report.projects) {
    for (const issue of result.issues) {
      const code = issue.code > 0 ? ` TS${issue.code}` : '';
      lines.push(
        `[${result.project}] ${issue.path}:${issue.line}:${issue.column}${code} ${issue.severity} ${issue.message}`
      );
    }
  }
  for (const finding of report.owned) {
    lines.push(
      `[owned files] engine/${finding.path ?? ''}:${finding.line ?? 1} ${finding.severity} ${finding.message}`
    );
  }
  const verdict = typecheckVerdict(report);
  if (lines.length > 0) lines.push('');
  lines.push(
    `Typecheck: ${verdict.errors} error(s), ${verdict.warnings} warning(s) across ${report.projects.length} project(s) and the owned files`
  );
  return lines;
}

/**
 * The `--json` document of a run.
 *
 * @param report - The report
 */
export function typecheckReportJson(report: TypecheckReport): JsonObject {
  const verdict = typecheckVerdict(report);
  return {
    pass: verdict.pass,
    errors: verdict.errors,
    warnings: verdict.warnings,
    projects: report.projects.map((result) => ({
      project: result.project,
      filesChecked: result.filesChecked,
      issues: result.issues.map((issue) => ({ ...issue })),
    })),
    owned: report.owned.map((finding) => ({
      path: finding.path ?? null,
      line: finding.line ?? null,
      severity: finding.severity,
      message: finding.message,
      group: finding.group ?? null,
    })),
  };
}
