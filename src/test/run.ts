// SPDX-License-Identifier: EUPL-1.2
/**
 * Running a test plan in a workspace and judging it.
 *
 * Before anything runs: the build must match the engine (or is built, with
 * `build`), leftovers of earlier runs of this workspace are terminated, and
 * the ports a browser harness binds are made usable. A headed run holds the
 * host's display lock.
 *
 * Each dispatch is one mach invocation with a raw log of its own. Its
 * verdict comes from {@link judgeDispatch}; a recognized harness failure is
 * retried a bounded number of times, because it says nothing about the
 * tests. Every line of output goes to the run's log under the workspace
 * state, which keeps the latest runs.
 *
 * The run is judged as a whole: every dispatch of every repetition must
 * pass, the engine must not have changed under the harness (otherwise the
 * result is inconclusive), and a validator, when given, must accept what
 * the harness produced.
 */
import { join } from 'node:path';

import {
  type BuildKind,
  ensureBuilt,
  readBuildBaseline,
  runMach,
  withDisplay,
  type Workspace,
} from '../engine/index.js';
import { captureWorktree, changedPaths } from '../git/index.js';
import { toError } from '../kernel/errors.js';
import {
  appendText,
  copyFile,
  ensureDir,
  listDir,
  readTextIfExists,
  remove,
  writeFile,
} from '../kernel/fs.js';
import { hash, randomId } from '../kernel/hash.js';
import { info, warn } from '../kernel/log.js';
import { run } from '../kernel/process/index.js';
import { s } from '../kernel/schema.js';
import { defineStateSection, readState, updateState } from '../project/index.js';
import {
  createMarkerTracker,
  type HarnessVerdict,
  isSilentSegfault,
  judgeDispatch,
  type StartMarkers,
} from './classify.js';
import {
  ENGINE_MARKER,
  harnessFallsBack,
  preparePorts,
  reapLeftovers,
  RUN_MARKER,
  sweepRun,
} from './host.js';
import { type PlannedDispatch, shuffled, type Suite, type TestPlan } from './plan.js';
import { type AssertionFailure, type RawTestLog, readRawTestLog } from './rawLog.js';
import { appPathArguments, repairStaleInstallLink, withProfileDir } from './xpcshell.js';

/** Retries of a dispatch the harness itself failed. */
const HARNESS_RETRIES = 2;
/** Runs whose logs a workspace keeps. */
const KEPT_RUNS = 10;

/** Why a run is not a pass, most structural first. */
export type FailureReason =
  'inconclusive' | 'crash' | 'server-startup' | 'no-tests' | 'test-failures' | 'validate';

const REASON_ORDER: readonly FailureReason[] = [
  'inconclusive',
  'crash',
  'server-startup',
  'no-tests',
  'test-failures',
  'validate',
];

/** One test file in one dispatch. */
export interface FileResult {
  test: string;
  /** The repetition, from 1. */
  run: number;
  /** The dispatch within the repetition, from 1. */
  dispatch: number;
  /** False for a record the harness wrote about something not requested, such as `automation.py`. */
  planned: boolean;
  started: boolean;
  finished: boolean;
  /** The `test_end` status. */
  status?: string;
  expected?: string;
  unexpected: boolean;
  durationMs?: number;
  failures: AssertionFailure[];
}

/** One mach invocation and its verdict. */
export interface DispatchResult {
  run: number;
  index: number;
  suite: Suite;
  paths: string[];
  exitCode: number;
  /** How many times it ran: more than one after a recognized harness failure. */
  attempts: number;
  verdict: HarnessVerdict;
  /** It died on SIGSEGV having printed nothing. */
  silentSegfault: boolean;
  files: FileResult[];
}

/** How a test run ended. */
export interface TestRunResult {
  pass: boolean;
  reason?: FailureReason;
  plan: TestPlan;
  dispatches: DispatchResult[];
  /** The run's complete output. */
  log: string;
  /** The engine state the run tested: a tree of its working tree. */
  tree: string;
  /** The build that ran first, when the run built. */
  built?: BuildKind;
  /** Processes of earlier or of this run that were terminated. */
  reaped: number;
  /** Engine paths that changed while the harness ran. */
  engineMoved?: string[];
  /** The validator's exit status, when one ran. */
  validateExit?: number;
}

/** What a run may do besides what its plan says. */
export interface RunOptions {
  /** Build first when the build is stale, instead of refusing. */
  build?: boolean;
  /** How long to wait for a build slot, the display, or a foreign port holder, in milliseconds. */
  waitMs?: number;
  /** Also keep the run's output at this path. */
  keepLog?: string;
}

/** The workspace's last green run: what it tested and how, on which engine tree and build. */
const lastGreenSection = defineStateSection(
  'test',
  s.object({
    lastGreen: s
      .object({
        tree: s.string({ min: 1 }),
        build: s.string({ min: 1 }),
        tests: s.array(s.string()),
        /** {@link planFingerprint} of the run. */
        plan: s.string().optional(),
      })
      .optional(),
  }),
  'fireforge test'
);

/** The build a run tests: the time the workspace's last build was recorded. */
async function buildIdentity(workspace: Workspace): Promise<string> {
  return (await readBuildBaseline(workspace))?.builtAt ?? 'unbuilt';
}

/**
 * Everything of a plan that decides how its tests run: the invocations, the
 * window, the repetitions and their order, the further mach arguments, the
 * harness environment and the validator. Where the artifacts go is left out.
 */
function planFingerprint(plan: TestPlan): string {
  return hash(
    JSON.stringify({
      dispatches: plan.dispatches,
      headed: plan.headed,
      repeat: plan.repeat,
      shuffle: plan.shuffle ?? null,
      machArgs: plan.machArgs ?? [],
      env: Object.entries(plan.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      validate: plan.validate ?? null,
    })
  );
}

/**
 * Whether the workspace recorded a green run of exactly these tests, run
 * exactly this way, on the engine tree and build it has now.
 *
 * @param workspace - The workspace
 * @param plan - The tests
 */
export async function isRecordedGreen(workspace: Workspace, plan: TestPlan): Promise<boolean> {
  const recorded = (await readState(workspace, lastGreenSection))?.lastGreen;
  if (
    recorded === undefined ||
    recorded.plan !== planFingerprint(plan) ||
    recorded.tests.length !== plan.tests.length ||
    plan.tests.some((test, index) => recorded.tests[index] !== test.path)
  ) {
    return false;
  }
  return (
    recorded.build === (await buildIdentity(workspace)) &&
    recorded.tree === (await captureWorktree(workspace.engineDir))
  );
}

/** The run's directory under the workspace state, after pruning older runs. */
async function openRunDirectory(workspace: Workspace): Promise<{ dir: string; id: string }> {
  const root = join(workspace.stateDir, 'test-runs');
  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${randomId().slice(0, 8)}`;
  const previous = (await listDir(root)).filter((entry) => entry.kind === 'directory');
  for (const entry of previous.slice(0, Math.max(0, previous.length - KEPT_RUNS + 1))) {
    await remove(join(root, entry.name)).catch(() => undefined);
  }
  const dir = join(root, id);
  await ensureDir(dir);
  return { dir, id };
}

/**
 * Appends lines to a file in arrival order, one write per burst. The file is
 * a copy for a person to read, so a write that fails does not fail the run:
 * it is reported once, and nothing further is written to a file that would
 * have a hole in it.
 */
function logSink(path: string): { line: (line: string) => void; close: () => Promise<void> } {
  let buffer = '';
  let failed = false;
  let writing: Promise<void> = Promise.resolve();
  const write = (text: string, first: boolean): void => {
    writing = writing
      .then(() => {
        if (failed) return undefined;
        return first ? writeFile(path, text, { durable: false }) : appendText(path, text);
      })
      .catch((error: unknown) => {
        failed = true;
        warn(`The run's output is incomplete in ${path}: ${toError(error).message}`);
      });
  };
  write('', true);
  const flush = (): void => {
    const text = buffer;
    buffer = '';
    if (text !== '') write(text, false);
  };
  return {
    line(line) {
      if (buffer === '') queueMicrotask(flush);
      buffer += `${line}\n`;
    },
    async close() {
      flush();
      await writing;
    },
  };
}

/** Pairs each planned path with what the raw log, or else the stream, says about it. */
function fileResults(
  paths: readonly string[],
  raw: RawTestLog | undefined,
  streamedStarts: readonly string[],
  where: { run: number; dispatch: number }
): FileResult[] {
  const same = (id: string, path: string): boolean =>
    id === path || id.endsWith(`/${path}`) || path.endsWith(`/${id}`);
  const results = raw?.results ?? [];
  const files: FileResult[] = paths.map((path) => {
    const result = results.find((entry) => same(entry.test, path));
    const started =
      (raw?.started ?? streamedStarts).some((id) => same(id, path)) || result !== undefined;
    return {
      test: path,
      ...where,
      planned: true,
      started,
      finished: result !== undefined,
      ...(result === undefined
        ? { unexpected: started }
        : {
            status: result.status,
            expected: result.expected,
            unexpected: result.unexpected,
            ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
          }),
      failures: result?.failures ?? [],
    };
  });
  for (const result of results) {
    if (paths.some((path) => same(result.test, path))) continue;
    files.push({
      test: result.test,
      ...where,
      planned: false,
      started: true,
      finished: true,
      status: result.status,
      expected: result.expected,
      unexpected: result.unexpected,
      failures: result.failures,
    });
  }
  return files;
}

/** Everything one run's dispatches share. */
interface RunContext {
  workspace: Workspace;
  plan: TestPlan;
  dir: string;
  id: string;
  log: (line: string) => void;
  portArgs: string[];
  failurePatterns: RegExp[];
  reaped: number;
}

async function machArguments(
  context: RunContext,
  dispatch: PlannedDispatch,
  rawLog: string
): Promise<string[]> {
  const { plan, workspace } = context;
  const caller = plan.machArgs ?? [];
  const coverage = plan.coverageDir === undefined ? [] : [`--jscov-dir-prefix=${plan.coverageDir}`];
  if (dispatch.suite === 'mochitest') {
    return [
      'mochitest',
      ...(plan.headed ? [] : ['--headless']),
      `--log-raw=${rawLog}`,
      ...(dispatch.restart ? ['--restart-between-tests'] : []),
      ...(plan.shuffle === undefined ? [] : ['--shuffle']),
      ...context.portArgs,
      ...coverage,
      ...caller,
      ...dispatch.paths,
    ];
  }
  if (dispatch.suite === 'xpcshell') {
    const appPath = await appPathArguments(
      workspace.engineDir,
      workspace.objDir,
      dispatch.paths,
      caller
    );
    return [
      'xpcshell-test',
      `--log-raw=${rawLog}`,
      ...appPath,
      ...coverage,
      ...caller,
      ...dispatch.paths,
    ];
  }
  return ['test', `--log-raw=${rawLog}`, ...caller, ...dispatch.paths];
}

function harnessEnvironment(
  context: RunContext,
  dispatch: PlannedDispatch
): Record<string, string> {
  const { plan, workspace } = context;
  return {
    ...plan.env,
    ...(plan.uploadDir === undefined ? {} : { MOZ_UPLOAD_DIR: plan.uploadDir }),
    ...(dispatch.suite === 'generic' && !plan.headed ? { MOZ_HEADLESS: '1' } : {}),
    [RUN_MARKER]: context.id,
    [ENGINE_MARKER]: workspace.engineDir,
  };
}

/** One attempt of one dispatch: mach run to the end, its helpers swept. */
async function attemptDispatch(
  context: RunContext,
  dispatch: PlannedDispatch,
  rawLog: string
): Promise<{ exitCode: number; output: string; markers: StartMarkers }> {
  const { workspace } = context;
  const args = await machArguments(context, dispatch, rawLog);
  context.log(`$ mach ${args.join(' ')}`);
  const execute = async (
    env: Record<string, string>
  ): Promise<{ exitCode: number; output: string; markers: StartMarkers }> => {
    const output: string[] = [];
    const markers = createMarkerTracker();
    const result = await runMach(workspace, args, {
      env,
      hints: false,
      onLine: (line) => {
        output.push(line);
        markers.line(line);
        context.log(line);
      },
      afterExit: async () => {
        context.reaped += (await sweepRun(workspace, context.id)).reaped;
      },
    });
    context.reaped += result.outlived;
    return {
      exitCode: result.exitCode,
      output: output.join('\n'),
      markers: markers.markers(),
    };
  };
  const env = harnessEnvironment(context, dispatch);
  if (dispatch.suite !== 'xpcshell') return execute(env);
  return withProfileDir(env, async (profiled) => {
    const first = await execute(profiled);
    if (first.exitCode === 0 || !(await repairStaleInstallLink(workspace.objDir, first.output))) {
      return first;
    }
    await remove(rawLog);
    return execute(profiled);
  });
}

async function runDispatch(
  context: RunContext,
  dispatch: PlannedDispatch,
  where: { run: number; index: number }
): Promise<DispatchResult> {
  for (let attempt = 1; ; attempt += 1) {
    const rawLog = join(
      context.dir,
      `run${where.run}-dispatch${where.index}-attempt${attempt}.raw.jsonl`
    );
    const outcome = await attemptDispatch(context, dispatch, rawLog);
    const raw = await readRawTestLog(rawLog);
    const verdict = judgeDispatch(outcome.exitCode, outcome.output, dispatch.paths, {
      raw,
      streamed: outcome.markers,
      failurePatterns: context.failurePatterns,
    });
    if (verdict.kind !== 'crash' || attempt > HARNESS_RETRIES) {
      return {
        run: where.run,
        index: where.index,
        suite: dispatch.suite,
        paths: dispatch.paths,
        exitCode: outcome.exitCode,
        attempts: attempt,
        verdict,
        silentSegfault: isSilentSegfault(outcome.exitCode, outcome.output),
        files: fileResults(dispatch.paths, raw, outcome.markers.started, {
          run: where.run,
          dispatch: where.index,
        }),
      };
    }
    warn(
      `The harness failed before giving a test result (${verdict.signature?.reason ?? 'unrecognized'}: ` +
        `${verdict.signature?.line ?? ''}); running the dispatch again (attempt ${attempt + 1} of ${HARNESS_RETRIES + 1}).`
    );
  }
}

/** The reason a dispatch verdict gives a run. */
export function dispatchReason(verdict: HarnessVerdict): FailureReason | undefined {
  if (verdict.kind === 'pass') return undefined;
  if (verdict.kind === 'crash') return verdict.signature?.verdictReason ?? 'crash';
  return verdict.kind;
}

function worstReason(reasons: readonly (FailureReason | undefined)[]): FailureReason | undefined {
  return REASON_ORDER.find((reason) => reasons.includes(reason));
}

/**
 * What a validator is told about where it runs: the project directory and
 * the engine of the workspace the judged run used.
 *
 * @param workspace - The workspace
 */
export function validatorEnvironment(workspace: Workspace): Record<string, string> {
  return {
    FIREFORGE_PROJECT_ROOT: workspace.project.root,
    FIREFORGE_ENGINE: workspace.engineDir,
  };
}

async function runValidator(workspace: Workspace, plan: TestPlan): Promise<number | undefined> {
  if (plan.validate === undefined) return undefined;
  const [program, ...args] = plan.validate.command;
  if (program === undefined) return undefined;
  info(`Validating the harness output: ${plan.validate.command.join(' ')}`);
  const result = await run(program, args, {
    cwd: plan.validate.cwd,
    env: { ...plan.env, ...validatorEnvironment(workspace) },
    onLine: (line) => {
      info(line);
    },
  });
  return result.exitCode;
}

async function dispatchAll(context: RunContext): Promise<DispatchResult[]> {
  const { plan } = context;
  const order =
    plan.shuffle === undefined
      ? plan.dispatches
      : [
          ...shuffled(
            plan.dispatches.filter((entry) => entry.suite === 'mochitest'),
            plan.shuffle
          ),
          ...plan.dispatches.filter((entry) => entry.suite !== 'mochitest'),
        ];
  const results: DispatchResult[] = [];
  for (let repetition = 1; repetition <= plan.repeat; repetition += 1) {
    for (const [index, dispatch] of order.entries()) {
      const label =
        dispatch.paths.length === 1
          ? (dispatch.paths[0] ?? '')
          : `${dispatch.paths.length} ${dispatch.suite} files`;
      info(
        `Dispatch ${index + 1}/${order.length}${plan.repeat > 1 ? ` of run ${repetition}/${plan.repeat}` : ''}: ${label}`
      );
      results.push(await runDispatch(context, dispatch, { run: repetition, index: index + 1 }));
    }
  }
  return results;
}

/**
 * Runs a plan in a workspace and judges the result. Call it while holding
 * the workspace.
 *
 * @param workspace - The workspace
 * @param plan - From `planTests`
 * @param options - See {@link RunOptions}
 * @returns The result; a red run is a result, not an exception
 * @throws `build-stale` when the build does not match and `build` is off,
 *   `port-busy` when a foreign process holds a harness port past the wait,
 *   `build-failed` and `lock-timeout` from the build and the display lock
 */
export async function runTests(
  workspace: Workspace,
  plan: TestPlan,
  options: RunOptions = {}
): Promise<TestRunResult> {
  const built = (await ensureBuilt(workspace, options))?.kind;
  const { dir, id } = await openRunDirectory(workspace);
  const log = join(dir, 'output.log');
  const sink = logSink(log);
  const config = workspace.project.config.test;
  const host = { engineDir: workspace.engineDir, objDir: workspace.objDir };
  const waitMs = options.waitMs ?? 0;
  try {
    const context: RunContext = {
      workspace,
      plan,
      dir,
      id,
      log: sink.line,
      portArgs: [],
      failurePatterns: (config.harnessFailurePatterns ?? []).map((pattern) => new RegExp(pattern)),
      reaped: await reapLeftovers(host),
    };
    const browser = plan.dispatches.some((entry) => entry.suite !== 'xpcshell');
    if (browser) {
      const runtests = await readTextIfExists(
        join(workspace.engineDir, 'testing/mochitest/runtests.py')
      );
      context.portArgs = await preparePorts(host, {
        ports: config.mochitestPorts,
        fallback: harnessFallsBack(runtests),
        waitMs,
      });
    }
    const tree = await captureWorktree(workspace.engineDir);
    const body = (): Promise<DispatchResult[]> => dispatchAll(context);
    const dispatches =
      plan.headed && browser
        ? await withDisplay(workspace.project.host, options.waitMs, body)
        : await body();
    const after = await captureWorktree(workspace.engineDir);
    const engineMoved =
      after === tree ? undefined : await changedPaths(workspace.engineDir, tree, after);
    let reason =
      engineMoved === undefined
        ? worstReason(dispatches.map((entry) => dispatchReason(entry.verdict)))
        : 'inconclusive';
    const validateExit = reason === undefined ? await runValidator(workspace, plan) : undefined;
    if (validateExit !== undefined && validateExit !== 0) reason = 'validate';
    if (reason === undefined) {
      const tests = plan.tests.map((test) => test.path);
      const identity = await buildIdentity(workspace);
      await updateState(workspace, lastGreenSection, () => ({
        lastGreen: { tree, build: identity, tests, plan: planFingerprint(plan) },
      }));
    }
    return {
      pass: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      plan,
      dispatches,
      log,
      tree,
      ...(built === undefined ? {} : { built }),
      reaped: context.reaped,
      ...(engineMoved === undefined ? {} : { engineMoved }),
      ...(validateExit === undefined ? {} : { validateExit }),
    };
  } finally {
    await sink.close();
    if (options.keepLog !== undefined) {
      await copyFile(log, options.keepLog).catch((error: unknown) => {
        warn(
          `Could not keep the run's output at ${options.keepLog ?? ''}: ${toError(error).message}`
        );
      });
    }
  }
}
