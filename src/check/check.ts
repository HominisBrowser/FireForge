// SPDX-License-Identifier: EUPL-1.2
/**
 * `check`: the composed static check. It runs the built-in steps (status,
 * verify, lint, typecheck, component validation, design tokens) and the
 * project's own `check.extraSteps` as one judgement, each step in this
 * process through the same feature function its own command calls.
 *
 * Steps that work in an engine (typecheck, component validation, an extra
 * step declaring `engine`) share one workspace for the whole check, taken
 * when the first of them starts. Steps run side by side unless one is
 * ordered after another.
 */
import { join } from 'node:path';

import { usageError } from '../cli/command.js';
import { CHECK_STEPS, type CheckExtraStep, type CheckStep } from '../config/index.js';
import type { Workspace } from '../engine/index.js';
import { loadFurnaceConfig, validateComponents, validationPasses } from '../furnace/index.js';
import { FireForgeError, toError } from '../kernel/errors.js';
import { ensureDir, exists, writeFile } from '../kernel/fs.js';
import { type JsonObject, writeJson } from '../kernel/json.js';
import { run } from '../kernel/process/index.js';
import { tailLines } from '../kernel/text.js';
import { formatDuration, mapLimit } from '../kernel/time.js';
import { lintReportJson, lintVerdict, renderLintReport, runLint } from '../lint/index.js';
import {
  deployComponents,
  lintSubject,
  ownedChanges,
  type OwnedFiles,
  ownedFiles,
  requireCurrentTyping,
  status,
  trackedFiles,
  typeCacheDir,
  verify,
  withOwnedRead,
  withWorkspaceOnDemand,
} from '../mode/index.js';
import type { Project } from '../project/index.js';
import { lintTokens, measureCoverage, type TokenSettings, tokenSettings } from '../tokens/index.js';
import { renderTypecheckReport, runTypecheck, typecheckVerdict } from '../typecheck/index.js';

/** Steps in flight at once. Most are bound by one thread or one disk, so more buys nothing. */
const CONCURRENCY = 4;
/** Lines of a failed extra step's output kept in the report. */
const OUTPUT_TAIL = 30;

/** How one step ended. */
export interface StepResult {
  name: string;
  kind: 'builtin' | 'extra';
  status: 'pass' | 'fail' | 'skipped';
  /** One line: the counts of a judged step, the refusal of a failed one, why a skipped one did not run. */
  detail: string;
  durationMs: number;
  /** For a skipped step: `config` when the project or the invocation left it out, `unavailable` when it has nothing to run. */
  skipped?: 'config' | 'unavailable';
  /** What a failed step reported, for a person. */
  output: string[];
}

/** The result of a check. */
export interface CheckReport {
  pass: boolean;
  /** The steps that keep the check from passing, by name. */
  failed: string[];
  steps: StepResult[];
  durationMs: number;
}

/** How {@link runCheck} runs. */
export interface CheckOptions {
  /** Run these steps only. */
  only?: readonly string[];
  /** Leave these steps out, besides `check.skip`. */
  skip?: readonly string[];
  /** How long to wait for the workspace, in milliseconds. */
  waitMs?: number | undefined;
  /** Source mode: lease this pool workspace. */
  workspace?: string | undefined;
  /** The workspace the caller already holds; the check then takes none. */
  held?: Workspace;
}

/** What a step's body reports; a thrown error is a failure with its message. */
type Outcome = { pass: boolean; detail: string; output?: string[] } | { unavailable: string };

interface Step {
  name: string;
  kind: 'builtin' | 'extra';
  after: readonly string[];
  run: () => Promise<Outcome>;
}

/** What the steps of one check share, each computed at most once. */
interface Shared {
  project: Project;
  /** Runs a read of the owned changes while nothing changes them (the shared engine lock in patch mode). */
  read: <T>(body: () => Promise<T>) => Promise<T>;
  /** The workspace, with the project's components deployed. */
  engine: () => Promise<Workspace>;
  /** Engine paths the project owns and still holds. */
  ownedPaths: () => Promise<string[]>;
}

function once<T>(compute: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= compute());
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

async function statusStep({ project, read }: Shared): Promise<Outcome> {
  const report = await read(() => status(project));
  const { failOn, allow = [] } = project.config.check.status ?? {};
  const failing = report.pending.filter(
    (problem) => (failOn?.includes(problem.code) ?? true) && !allow.includes(problem.code)
  );
  if (failing.length === 0) {
    return { pass: true, detail: `${plural(report.owned.length, 'owned path')}, nothing failing` };
  }
  const counts = new Map<string, number>();
  for (const problem of failing) counts.set(problem.code, (counts.get(problem.code) ?? 0) + 1);
  return {
    pass: false,
    detail: [...counts].map(([code, count]) => `${count} ${code}`).join(', '),
    output: failing.map(
      (problem) =>
        `${problem.code}  ${problem.subject === undefined ? '' : `${problem.subject}: `}${problem.message}`
    ),
  };
}

async function verifyStep({ project, read }: Shared): Promise<Outcome> {
  const { problems } = await read(() => verify(project));
  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? 'sound' : plural(problems.length, 'problem'),
    output: problems.map(
      (problem) =>
        `${problem.code}  ${problem.subject === undefined ? '' : `${problem.subject}: `}${problem.message}`
    ),
  };
}

async function lintStep({ project, read }: Shared): Promise<Outcome> {
  const subject = await read(() => lintSubject(project, { scope: 'queue' }));
  const report = await runLint(subject.changes, subject.engine, project.config, {
    projectRoot: project.root,
    sequential: subject.sequential,
    components: subject.components,
    cacheDir: typeCacheDir(project),
    ...(subject.tokens === undefined ? {} : { tokens: subject.tokens }),
  });
  const verdict = lintVerdict(report, project.config.check.maxWarnings?.lint);
  const { lintReport } = project.config.check;
  if (lintReport !== undefined) {
    await writeJson(join(project.root, lintReport), lintReportJson(report, verdict));
  }
  return {
    pass: verdict.pass,
    detail: `${plural(verdict.errors, 'error')}, ${plural(verdict.warnings, 'warning')}`,
    output: verdict.pass ? [] : renderLintReport(report, verdict, false),
  };
}

async function typecheckStep({ project, engine }: Shared): Promise<Outcome> {
  if (project.config.typecheck === undefined) {
    return { unavailable: 'no "typecheck" block in fireforge.json' };
  }
  await requireCurrentTyping(project);
  const workspace = await engine();
  const subject = await lintSubject(project, { workspace });
  const report = await runTypecheck({
    config: project.config,
    projectRoot: project.root,
    engineDir: workspace.engineDir,
    changes: subject.changes,
    engine: subject.engine,
    cacheDir: typeCacheDir(project),
  });
  const verdict = typecheckVerdict(report);
  return {
    pass: verdict.pass,
    detail: `${plural(verdict.errors, 'error')}, ${plural(verdict.warnings, 'warning')}`,
    output: verdict.pass ? [] : renderTypecheckReport(report),
  };
}

async function furnaceStep({ project, engine }: Shared): Promise<Outcome> {
  if (!(await exists(project.paths.furnace))) return { unavailable: 'no furnace.json' };
  const report = await validateComponents(project, await trackedFiles(project), {
    workspace: await engine(),
  });
  return {
    pass: validationPasses(report, project.config.check.maxWarnings?.furnace),
    detail: `${plural(report.judged, 'component')}: ${plural(report.errors, 'error')}, ${plural(report.warnings, 'warning')}`,
    output: report.findings.map(
      (finding) => `${finding.severity} ${finding.component} [${finding.check}] ${finding.message}`
    ),
  };
}

/** Judges the token file with the project's conventions over the owned stylesheets, held still. */
async function judgeTokens(
  { project, read }: Shared,
  judge: (owned: OwnedFiles, settings: TokenSettings) => Promise<Outcome>
): Promise<Outcome> {
  const furnace = (await exists(project.paths.furnace))
    ? await loadFurnaceConfig(project)
    : undefined;
  const settings = tokenSettings(furnace, project.config.binaryName);
  return read(async () => {
    const owned = await ownedFiles(project);
    return (await owned.read(settings.file)) === undefined
      ? { unavailable: `the project has no token file (${settings.file})` }
      : judge(owned, settings);
  });
}

function tokenCoverageStep(shared: Shared): Promise<Outcome> {
  return judgeTokens(shared, async (owned, settings) => {
    const report = await measureCoverage(settings.file, owned, settings);
    const floor = shared.project.config.check.minTokenCoverage;
    const pass = floor === undefined || report.percent >= floor;
    return {
      pass,
      detail: `coverage ${report.percent}%${pass ? '' : `, below ${String(floor)}%`}`,
      output: pass
        ? []
        : report.files
            .filter((file) => file.rawColors + file.unknownVars > 0)
            .map(
              (file) =>
                `${file.file}  raw colors ${file.rawColors} | unknown variables ${file.unknownVars}`
            ),
    };
  });
}

function tokenLintStep(shared: Shared): Promise<Outcome> {
  return judgeTokens(shared, async (owned, settings) => {
    const { filesScanned, findings } = await lintTokens(settings.file, owned, settings);
    return {
      pass: findings.length === 0,
      detail: `${plural(findings.length, 'finding')} in ${plural(filesScanned, 'stylesheet')}`,
      output: findings.map(
        (finding) => `${finding.file}:${finding.line} [${finding.check}] ${finding.message}`
      ),
    };
  });
}

const BUILTIN: Readonly<
  Record<CheckStep, { after?: readonly CheckStep[]; run: (shared: Shared) => Promise<Outcome> }>
> = {
  status: { run: statusStep },
  verify: { run: verifyStep },
  lint: { run: lintStep },
  // Both type passes write one result cache.
  typecheck: { after: ['lint'], run: typecheckStep },
  'furnace-validate': { run: furnaceStep },
  'token-coverage': { run: tokenCoverageStep },
  'token-lint': { run: tokenLintStep },
};

/**
 * Runs a project command as a step. Its environment names the project root
 * (`FIREFORGE_PROJECT_ROOT`), a file listing the owned engine paths one per
 * line (`FIREFORGE_OWNED_PATHS`), the lint step's report when
 * `check.lintReport` is set (`FIREFORGE_CHECK_LINT_REPORT`), and, for a step
 * declaring `engine`, the engine directory (`FIREFORGE_ENGINE`).
 */
async function extraStep(shared: Shared, step: CheckExtraStep): Promise<Outcome> {
  const { project } = shared;
  const listing = join(project.paths.stateDir, 'check', 'owned-paths.txt');
  await ensureDir(join(project.paths.stateDir, 'check'));
  await writeFile(listing, (await shared.ownedPaths()).map((path) => `${path}\n`).join(''));
  const { lintReport } = project.config.check;
  const [program = '', ...args] = step.command;
  const result = await run(program, args, {
    cwd: project.root,
    env: {
      FIREFORGE_PROJECT_ROOT: project.root,
      FIREFORGE_OWNED_PATHS: listing,
      ...(lintReport === undefined
        ? {}
        : { FIREFORGE_CHECK_LINT_REPORT: join(project.root, lintReport) }),
      ...(step.engine ? { FIREFORGE_ENGINE: (await shared.engine()).engineDir } : {}),
    },
    timeoutMs: step.timeout * 1000,
    timeoutIsResult: true,
    processGroup: true,
  });
  const lines = tailLines(`${result.stdout}\n${result.stderr}`.trim(), OUTPUT_TAIL);
  if (result.timedOut) {
    return { pass: false, detail: `timed out after ${step.timeout}s`, output: lines };
  }
  return result.exitCode === 0
    ? { pass: true, detail: '' }
    : { pass: false, detail: `exit ${result.exitCode}`, output: lines };
}

/** The steps the invocation selected, and the rows of those it left out by name. */
function selectSteps(
  project: Project,
  shared: Shared,
  options: CheckOptions
): { steps: Step[]; excluded: StepResult[] } {
  const extras = project.config.check.extraSteps ?? [];
  const all: Step[] = [
    ...CHECK_STEPS.map((name): Step => ({
      name,
      kind: 'builtin',
      after: BUILTIN[name].after ?? [],
      run: () => BUILTIN[name].run(shared),
    })),
    ...extras.map((step): Step => ({
      name: step.name,
      kind: 'extra',
      after: step.after ?? [],
      run: () => extraStep(shared, step),
    })),
  ];
  const known = new Set(all.map((step) => step.name));
  for (const name of [...(options.only ?? []), ...(options.skip ?? [])]) {
    if (!known.has(name)) {
      throw usageError(`"${name}" is not a check step`, `Steps: ${[...known].join(', ')}.`);
    }
  }
  const only = options.only ?? [];
  const candidates = only.length === 0 ? all : all.filter((step) => only.includes(step.name));
  const configured: readonly string[] = project.config.check.skip ?? [];
  const why = (name: string): string | undefined =>
    options.skip?.includes(name) === true
      ? 'skipped by --skip'
      : configured.includes(name)
        ? 'skipped by check.skip in fireforge.json'
        : undefined;
  return {
    steps: candidates.filter((step) => why(step.name) === undefined),
    excluded: candidates.flatMap((step): StepResult[] => {
      const detail = why(step.name);
      return detail === undefined
        ? []
        : [
            {
              name: step.name,
              kind: step.kind,
              status: 'skipped',
              detail,
              durationMs: 0,
              skipped: 'config',
              output: [],
            },
          ];
    }),
  };
}

async function runStep(step: Step): Promise<StepResult> {
  const startedAt = Date.now();
  const base = { name: step.name, kind: step.kind };
  try {
    const outcome = await step.run();
    const durationMs = Date.now() - startedAt;
    if ('unavailable' in outcome) {
      return {
        ...base,
        status: 'skipped',
        detail: outcome.unavailable,
        durationMs,
        skipped: 'unavailable',
        output: [],
      };
    }
    return {
      ...base,
      status: outcome.pass ? 'pass' : 'fail',
      detail: outcome.detail,
      durationMs,
      output: outcome.pass ? [] : (outcome.output ?? []),
    };
  } catch (error: unknown) {
    // A lock that never came says nothing about the project: the check did not run.
    if (error instanceof FireForgeError && error.code === 'lock-timeout') throw error;
    const failure = toError(error);
    const hint = error instanceof FireForgeError ? error.hint : undefined;
    return {
      ...base,
      status: 'fail',
      detail: failure.message.split('\n')[0] ?? '',
      durationMs: Date.now() - startedAt,
      output: [failure.message, ...(hint === undefined ? [] : [hint])],
    };
  }
}

/** Runs the steps in waves: each wave is every step whose `after` steps have finished. */
async function runSteps(steps: readonly Step[]): Promise<StepResult[]> {
  const selected = new Set(steps.map((step) => step.name));
  const finished = new Map<string, StepResult>();
  let waiting = [...steps];
  while (waiting.length > 0) {
    const ready = waiting.filter((step) =>
      step.after.every((name) => !selected.has(name) || finished.has(name))
    );
    const results = await mapLimit(ready, CONCURRENCY, runStep);
    for (const result of results) finished.set(result.name, result);
    waiting = waiting.filter((step) => !finished.has(step.name));
  }
  return steps.flatMap((step) => finished.get(step.name) ?? []);
}

/**
 * Runs the composed static check.
 *
 * @param project - The project
 * @param options - See {@link CheckOptions}
 * @returns The report; a red step is a result, not an exception
 * @throws `invalid-argument` for an unknown step name, `lock-timeout` (exit
 *   code 15) when the workspace never came free, and in patch mode
 *   `engine-missing` before `download`
 */
export async function runCheck(project: Project, options: CheckOptions = {}): Promise<CheckReport> {
  const startedAt = Date.now();
  const body = async (workspace: () => Promise<Workspace>): Promise<CheckReport> => {
    // A caller holding the workspace (the gate) already keeps the owned changes still.
    const read = <R>(run: () => Promise<R>): Promise<R> =>
      options.held === undefined
        ? withOwnedRead(project, { command: 'check', waitMs: options.waitMs }, run)
        : run();
    const shared: Shared = {
      project,
      read,
      engine: once(async () => {
        const leased = await workspace();
        await deployComponents(leased, { waitMs: options.waitMs });
        return leased;
      }),
      ownedPaths: once(async () =>
        (await read(() => ownedChanges(project)))
          .net()
          .filter((change) => change.kind !== 'delete')
          .map((change) => change.path)
      ),
    };
    const { steps, excluded } = selectSteps(project, shared, options);
    const results = [...(await runSteps(steps)), ...excluded];
    const order = new Map(
      [...CHECK_STEPS, ...(project.config.check.extraSteps ?? []).map((step) => step.name)].map(
        (name, index) => [name, index]
      )
    );
    results.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    const { failOnSkipped } = project.config.check;
    const failed = results
      .filter((step) => step.status === 'fail' || (failOnSkipped && step.skipped === 'unavailable'))
      .map((step) => step.name);
    return {
      pass: failed.length === 0,
      failed,
      steps: results,
      durationMs: Date.now() - startedAt,
    };
  };
  const { held } = options;
  if (held !== undefined) return body(() => Promise.resolve(held));
  // Every step only reads the engine; one that needs it takes it shared when it starts.
  return withWorkspaceOnDemand(
    project,
    { command: 'check', waitMs: options.waitMs, workspace: options.workspace, write: false },
    body
  );
}

/**
 * The report for a person: one row per step, the output of each failed
 * step under its row, and a summary line.
 *
 * @param report - The report
 */
export function renderCheck(report: CheckReport): string[] {
  const width = Math.max(...report.steps.map((step) => step.name.length), 4);
  const lines: string[] = [];
  for (const step of report.steps) {
    const time = step.status === 'skipped' ? '' : formatDuration(step.durationMs);
    lines.push(
      `${step.name.padEnd(width)}  ${step.status.padEnd(7)}  ${time.padStart(6)}  ${step.detail}`.trimEnd()
    );
    for (const line of step.output) lines.push(`    ${line}`);
  }
  const count = (state: StepResult['status']): number =>
    report.steps.filter((step) => step.status === state).length;
  lines.push(
    `Check ${report.pass ? 'passed' : `failed (${report.failed.join(', ')})`}: ` +
      `${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped in ${formatDuration(report.durationMs)}.`
  );
  return lines;
}

/**
 * The report as the `--json` document of `check`.
 *
 * @param report - The report
 */
export function checkJson(report: CheckReport): JsonObject {
  return {
    pass: report.pass,
    failed: report.failed,
    durationMs: report.durationMs,
    steps: report.steps.map((step) => ({
      name: step.name,
      kind: step.kind,
      status: step.status,
      detail: step.detail,
      durationMs: step.durationMs,
      skipped: step.skipped ?? null,
      output: step.output,
    })),
  };
}
