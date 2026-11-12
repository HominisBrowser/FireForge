// SPDX-License-Identifier: EUPL-1.2
/**
 * What a test run reports: the `FIREFORGE-VERDICT:` fields, the results
 * document (`--results` and `--json`), and the lines a person reads.
 */
import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { type JsonObject, writeJson } from '../kernel/json.js';
import type { GreenSummaryRejection, HarnessVerdict, IncompleteRun } from './classify.js';
import type { ControlResult } from './control.js';
import { dispatchReason, type DispatchResult, type TestRunResult } from './run.js';

/** `key=value` pairs for `ctx.out.verdict`. */
export type VerdictFields = Record<string, string | number | undefined>;

/** The note a passing dispatch carries when it overruled harness noise. */
function passNote(verdict: HarnessVerdict): string | undefined {
  if (verdict.kind !== 'pass') return undefined;
  if (verdict.note === 'teardown-noise-ignored') return verdict.note;
  return verdict.greenSummaryOverride === true ? 'exit-noise-ignored' : undefined;
}

function incompleteFields(incomplete: IncompleteRun | undefined): VerdictFields {
  if (incomplete === undefined) return {};
  return {
    ...(incomplete.firstUnstarted === undefined
      ? {}
      : {
          started: `${incomplete.started}/${incomplete.requested}`,
          'first-unstarted': incomplete.firstUnstarted,
          'started-source': incomplete.startedSource,
        }),
    unfinished: incomplete.unfinished?.length,
    'app-exit': incomplete.appExit,
  };
}

/** The dispatch that decides the run's reason: the first with the run's reason. */
function decidingDispatch(result: TestRunResult): DispatchResult | undefined {
  return (
    result.dispatches.find((dispatch) => dispatchReason(dispatch.verdict) === result.reason) ??
    result.dispatches[0]
  );
}

/**
 * The verdict line of a run: `PASS` or `FAIL reason=<reason>`, the summary
 * counts of a single dispatch, `shards=` and `runs=` of several, where an
 * incomplete run stopped, and where its log and results are.
 *
 * @param result - The run
 * @param extra - Further fields: `results=`, `control=`
 */
export function verdictFields(
  result: TestRunResult,
  extra: VerdictFields = {}
): { pass: boolean; fields: VerdictFields } {
  const perRun = result.plan.dispatches.length;
  const single = result.dispatches.length === 1 ? result.dispatches[0] : undefined;
  const deciding = result.pass ? single : decidingDispatch(result);
  const runsPassed = Array.from({ length: result.plan.repeat }, (_, index) =>
    result.dispatches
      .filter((dispatch) => dispatch.run === index + 1)
      .every((dispatch) => dispatch.verdict.kind === 'pass')
  ).filter(Boolean).length;
  const fields: VerdictFields = {
    reason: result.reason,
    note: single === undefined ? undefined : passNote(single.verdict),
    checks: single?.verdict.checks,
    unexpected: single?.verdict.unexpected,
    shards:
      perRun > 1 && result.plan.repeat === 1
        ? `${result.dispatches.filter((dispatch) => dispatch.verdict.kind === 'pass').length}/${perRun}`
        : undefined,
    runs: result.plan.repeat > 1 ? `${runsPassed}/${result.plan.repeat}` : undefined,
    ...incompleteFields(deciding?.verdict.incomplete),
    shuffle: result.plan.shuffle,
    'orphans-reaped': result.reaped > 0 ? result.reaped : undefined,
    log: result.log,
    ...extra,
  };
  return { pass: result.pass, fields };
}

/**
 * The verdict line of a negative control: the mutated run's line with
 * `control=`, or the baseline's when the mutation was never applied.
 *
 * @param control - The control
 * @param extra - Further fields
 */
function controlVerdictFields(
  control: ControlResult,
  extra: VerdictFields = {}
): { pass: boolean; fields: VerdictFields } {
  const run = control.mutated ?? control.baseline;
  const base = run === undefined ? { fields: {} } : verdictFields(run, extra);
  return {
    pass: control.outcome === 'caught',
    fields: {
      ...base.fields,
      reason:
        control.outcome === 'caught'
          ? undefined
          : control.outcome === 'inconclusive'
            ? 'inconclusive'
            : `control-${control.outcome}`,
      control: control.outcome,
      'control-restore-build': control.restoreBuild,
    },
  };
}

/**
 * The verdict line of a run refused before the harness: `reason=preflight`
 * with the refusal's class, or `lock-timeout` when it never got its lock.
 *
 * @param error - What was thrown
 */
export function refusalVerdict(error: unknown): VerdictFields {
  const code = error instanceof FireForgeError ? error.code : 'internal';
  return code === 'lock-timeout' ? { reason: 'lock-timeout' } : { reason: 'preflight', note: code };
}

/**
 * The refusal's own text, for stdout before the verdict line.
 *
 * @param error - What was thrown
 */
export function refusalLines(error: unknown): string[] {
  if (error instanceof FireForgeError) {
    return ['Preflight refused:', error.message, ...(error.hint === undefined ? [] : [error.hint])];
  }
  return ['Preflight refused:', toError(error).message];
}

function verdictJson(verdict: HarnessVerdict): JsonObject {
  return {
    kind: verdict.kind,
    ...(verdict.checks === undefined ? {} : { checks: verdict.checks }),
    ...(verdict.unexpected === undefined ? {} : { unexpected: verdict.unexpected }),
    ...(verdict.signature === undefined ? {} : { signature: { ...verdict.signature } }),
    ...(verdict.failureLine === undefined ? {} : { failureLine: verdict.failureLine }),
    ...(verdict.note === undefined ? {} : { note: verdict.note }),
    ...(verdict.greenSummaryRejected === undefined
      ? {}
      : { greenSummaryRejected: { ...verdict.greenSummaryRejected } }),
    ...(verdict.incomplete === undefined ? {} : { incomplete: { ...verdict.incomplete } }),
  };
}

/**
 * The results document of a run: every dispatch with its verdict, every
 * test file with whether it started and finished, its status and its reds,
 * and the run-level summary.
 */
function resultsDocument(result: TestRunResult): JsonObject {
  const files = result.dispatches.flatMap((dispatch) => dispatch.files);
  return {
    verdict: result.pass ? 'pass' : 'fail',
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    log: result.log,
    tree: result.tree,
    tests: result.plan.tests.map((test) => ({ ...test })),
    dispatches: result.dispatches.map((dispatch) => ({
      run: dispatch.run,
      index: dispatch.index,
      suite: dispatch.suite,
      paths: dispatch.paths,
      exitCode: dispatch.exitCode,
      attempts: dispatch.attempts,
      verdict: verdictJson(dispatch.verdict),
    })),
    files: files.map((file) => ({
      ...file,
      failures: file.failures.map((failure) => ({ ...failure })),
    })),
    summary: {
      files: files.filter((file) => file.planned).length,
      passed: files.filter((file) => file.planned && file.finished && !file.unexpected).length,
      failed: files.filter((file) => file.finished && file.unexpected).length,
      unfinished: files.filter((file) => file.started && !file.finished).length,
      neverStarted: files.filter((file) => file.planned && !file.started).length,
      reaped: result.reaped,
    },
    ...(result.built === undefined ? {} : { built: result.built }),
    ...(result.engineMoved === undefined ? {} : { engineMoved: result.engineMoved }),
    ...(result.validateExit === undefined ? {} : { validateExit: result.validateExit }),
  };
}

/**
 * The results document of a negative control: its outcome, and the
 * unmutated and mutated runs.
 *
 * @param control - The control
 */
function controlDocument(control: ControlResult): JsonObject {
  return {
    verdict: control.outcome === 'caught' ? 'pass' : 'fail',
    control: control.outcome,
    ...(control.why === undefined ? {} : { why: control.why }),
    targets: control.targets,
    ...(control.restoreBuild === undefined ? {} : { restoreBuild: control.restoreBuild }),
    ...(control.baseline === undefined ? {} : { baseline: resultsDocument(control.baseline) }),
    ...(control.mutated === undefined ? {} : { mutated: resultsDocument(control.mutated) }),
  };
}

/** Version of the results document `--results` writes. */
const RESULTS_SCHEMA_VERSION = 1;

/**
 * Writes a results document to the path `--results` names.
 *
 * @param path - The destination
 * @param document - From {@link resultsDocument} or {@link controlDocument}
 */
export async function writeResults(path: string, document: JsonObject): Promise<void> {
  await writeJson(path, { schemaVersion: RESULTS_SCHEMA_VERSION, ...document });
}

/** Why a green-looking summary was refused. */
function greenSummaryRejectedMessage(rejection: GreenSummaryRejection, exitCode: number): string {
  const evidence = [
    ...(rejection.crashLine === undefined ? [] : [`  - crash evidence: ${rejection.crashLine}`]),
    ...(rejection.exitEvidence === undefined ? [] : [`  - ${rejection.exitEvidence}`]),
    ...(rejection.neverStarted.length === 0
      ? []
      : [`  - requested test file(s) that never started: ${rejection.neverStarted.join(', ')}`]),
    ...(rejection.neverEnded.length === 0
      ? []
      : [`  - test file(s) that started but never finished: ${rejection.neverEnded.join(', ')}`]),
  ];
  return (
    `mach exited ${exitCode} and the embedded suite summary looks green, but it was NOT treated as a pass:\n` +
    `${evidence.join('\n')}\n` +
    'A run cut short by a crash or truncation under-reports: its counts cover only the files that ran before it died.'
  );
}

/** Why a would-be pass was failed by the completeness veto. */
function incompleteRunMessage(evidence: IncompleteRun): string {
  const lines = [
    ...(evidence.firstUnstarted === undefined
      ? []
      : [
          evidence.requested > 0 && evidence.started < evidence.requested
            ? `  - only ${evidence.started} of ${evidence.requested} requested test files started; the first that never started is ${evidence.firstUnstarted}`
            : `  - the raw log has no test under the requested ${evidence.firstUnstarted}`,
        ]),
    ...(evidence.unfinished === undefined
      ? []
      : [
          `  - ${evidence.unfinished.length} test file(s) started and never finished: ${evidence.unfinished.join(', ')}`,
        ]),
    ...(evidence.shutdownLine === undefined
      ? []
      : [`  - the browser shut down in the middle of a test: ${evidence.shutdownLine}`]),
    ...(evidence.appExit === undefined ? [] : [`  - the browser died of ${evidence.appExit}`]),
    ...(evidence.unexpected === undefined
      ? []
      : [`  - the suite reported ${evidence.unexpected} unexpected result(s)`]),
  ];
  return `The run is incomplete and was NOT treated as a pass:\n${lines.join('\n')}`;
}

/** What a recognized harness failure was, once its retries were spent. */
function crashMessage(verdict: HarnessVerdict, attempts: number): string {
  const signature = verdict.signature;
  if (signature?.verdictReason === 'server-startup') {
    return (
      `A mochitest server could not start on all ${attempts} attempt(s), so no test ran: ${signature.line}\n` +
      'Another harness most likely held its port; "lsof -nP -iTCP:8888" names the holder.'
    );
  }
  const context =
    signature?.harnessLines === undefined
      ? ''
      : `\nHarness lines before the timeout:\n${signature.harnessLines.map((line) => `  ${line}`).join('\n')}\n` +
        'A harness in another workspace holding one of these ports can stall this one.';
  return (
    `The harness failed around the tests, not in them, on all ${attempts} attempt(s).\n` +
    `Recognized: ${signature?.reason ?? 'no recognized shape'}\nEvidence: ${signature?.line ?? '(none)'}${context}`
  );
}

/** The cause a silent SIGSEGV almost always has. */
function silentSegfaultMessage(exitCode: number): string {
  return (
    `The harness died on SIGSEGV (exit ${exitCode}) having printed nothing at all.\n` +
    'Check first: a .sys.mjs that a packaged module imports but whose EXTRA_JS_MODULES (or namespaced ' +
    'module list) registration is missing from moz.build. The module loader faults before any logging ' +
    'exists, so this is all it leaves. "fireforge lint" names a new unregistered module; an import added ' +
    'to an existing module needs "fireforge verify". Only then look for a product crash, which prints a dump.'
  );
}

/** Why nothing ran. */
function noTestsMessage(dispatch: DispatchResult): string {
  const exit =
    dispatch.exitCode === 0
      ? 'The harness exited 0, but a summary without a single test start is not a result.'
      : `The harness exited ${dispatch.exitCode} before any test started.`;
  const zero =
    dispatch.verdict.checks === 0
      ? ' The summary counted zero checks, which is also what a browser dying at startup leaves: a chrome or ' +
        'resource URL that resolves to nothing after a UI build crashes it before any output. A full ' +
        '"fireforge build" is the repair to try.'
      : '';
  return `No requested test ran. ${exit}${zero}\nRequested: ${dispatch.paths.join(', ')}`;
}

function dispatchLines(dispatch: DispatchResult, label: string): string[] {
  const { verdict } = dispatch;
  const reason = dispatchReason(verdict);
  const counts = [
    verdict.checks === undefined ? '' : ` checks=${verdict.checks}`,
    verdict.unexpected === undefined ? '' : ` unexpected=${verdict.unexpected}`,
  ].join('');
  const lines = [`${reason === undefined ? 'PASS' : `FAIL ${reason}`}${counts}  ${label}`];
  for (const file of dispatch.files) {
    for (const failure of file.failures) {
      lines.push(
        `  ${file.test}: ${failure.status} (expected ${failure.expected}) ${failure.assertion}${failure.message === undefined ? '' : ` - ${failure.message}`}`
      );
    }
  }
  if (dispatch.silentSegfault) lines.push(silentSegfaultMessage(dispatch.exitCode));
  else if (verdict.kind === 'crash') lines.push(crashMessage(verdict, dispatch.attempts));
  else if (verdict.kind === 'no-tests') lines.push(noTestsMessage(dispatch));
  if (verdict.greenSummaryRejected !== undefined) {
    lines.push(greenSummaryRejectedMessage(verdict.greenSummaryRejected, dispatch.exitCode));
  }
  if (verdict.incomplete !== undefined && reason !== undefined)
    lines.push(incompleteRunMessage(verdict.incomplete));
  if (reason === 'test-failures' && dispatch.files.every((file) => file.failures.length === 0)) {
    lines.push(
      ...(verdict.failureBlocks ?? (verdict.failureLine === undefined ? [] : [verdict.failureLine]))
    );
  }
  if (verdict.note !== undefined && reason !== undefined) lines.push(`(${verdict.note})`);
  return lines;
}

/**
 * The lines a person reads about a run: one per dispatch with its reds and
 * what its failure means.
 *
 * @param result - The run
 */
function renderRun(result: TestRunResult): string[] {
  const lines: string[] = [];
  for (const dispatch of result.dispatches) {
    const files =
      dispatch.paths.length === 1
        ? (dispatch.paths[0] ?? '')
        : `${dispatch.paths.length} ${dispatch.suite} files`;
    const where = result.plan.repeat > 1 ? `run ${dispatch.run}, ` : '';
    lines.push(...dispatchLines(dispatch, `${where}${files}`));
  }
  if (result.engineMoved !== undefined) {
    lines.push(
      `The engine changed while the harness ran, so the result was discarded: ${result.engineMoved.slice(0, 10).join(', ')}`
    );
  }
  if (result.validateExit !== undefined && result.validateExit !== 0) {
    lines.push(`The validator rejected what the harness produced (exit ${result.validateExit}).`);
  }
  return lines;
}

/** What each outcome of a control tells a person, and how a failed one ends the command. */
const CONTROL_OUTCOMES: Readonly<
  Record<
    ControlResult['outcome'],
    { line: (why: string) => string; exitCode?: ExitCode; message?: string; hint?: string }
  >
> = {
  caught: {
    line: () => 'Negative control caught: the tests went red at exactly the expected assertions.',
  },
  missed: {
    line: () => 'Negative control MISSED: the tests stayed green with the mutation applied.',
    exitCode: ExitCode.BUILD_ERROR,
    message: 'The tests stayed green with the mutation applied',
    hint: 'Strengthen the tests until they fail on the mutation.',
  },
  'wrong-red': {
    line: (why) => `Negative control FAILED, red at the wrong assertions: ${why}`,
    exitCode: ExitCode.BUILD_ERROR,
    message: 'The negative control went red, but not at exactly the expected assertions',
    hint: 'Correct --expect when the mutation breaks what the run shows, or narrow the mutation or the tests until only the expected assertions fail.',
  },
  'baseline-red': {
    line: (why) => `Negative control FAILED, red without the mutation: ${why}`,
    exitCode: ExitCode.BUILD_ERROR,
    message: 'The negative control was not run',
    hint: 'Make the tests pass without the mutation, then run the control again.',
  },
  inconclusive: {
    line: (why) => `Negative control inconclusive: ${why}`,
    exitCode: ExitCode.INCONCLUSIVE,
    message: 'The negative control proved nothing',
    hint: 'Run the control again once the engine is quiet.',
  },
};

/**
 * The lines a person reads about a negative control.
 *
 * @param control - The control
 */
function renderControl(control: ControlResult): string[] {
  const runs = [
    ...(control.baseline === undefined
      ? []
      : ['Without the mutation:', ...renderRun(control.baseline)]),
    ...(control.mutated === undefined ? [] : ['With the mutation:', ...renderRun(control.mutated)]),
  ];
  return [...runs, CONTROL_OUTCOMES[control.outcome].line(control.why ?? '')];
}

/** Everything a command reports about a finished run or control. */
export interface TestReport {
  /** For a person, on stdout. */
  lines: string[];
  /** The results document. */
  document: JsonObject;
  /** The verdict line. */
  pass: boolean;
  fields: VerdictFields;
  /** What the command ends with when it did not pass: exit 5 for a red or a failed control, 14 for inconclusive. */
  failure?: FireForgeError;
}

/**
 * The report of a finished run.
 *
 * @param result - The run
 * @param extra - Further verdict fields, such as `results=`
 */
export function runReport(result: TestRunResult, extra: VerdictFields = {}): TestReport {
  const { pass, fields } = verdictFields(result, extra);
  const failure =
    result.reason === undefined
      ? undefined
      : result.reason === 'inconclusive'
        ? new FireForgeError(
            'test-inconclusive',
            `The engine changed while the harness ran (${(result.engineMoved ?? []).slice(0, 5).join(', ')}); the result was discarded.`,
            {
              exitCode: ExitCode.INCONCLUSIVE,
              hint: 'Run the tests again once the engine is quiet.',
            }
          )
        : new FireForgeError('test-failure', `The tests did not pass (reason=${result.reason}).`, {
            exitCode: ExitCode.BUILD_ERROR,
            hint: `The lines above say what failed; the complete output is ${result.log}.`,
          });
  return {
    lines: renderRun(result),
    document: resultsDocument(result),
    pass,
    fields,
    ...(failure === undefined ? {} : { failure }),
  };
}

/**
 * The report of a negative control. A control that failed (`missed`,
 * `wrong-red`, `baseline-red`) ends with `control-<outcome>` and exit 5; one
 * whose engine moved under it ends with `control-inconclusive` and exit 14.
 *
 * @param control - The control
 * @param extra - Further verdict fields
 */
export function controlReport(control: ControlResult, extra: VerdictFields = {}): TestReport {
  const { pass, fields } = controlVerdictFields(control, extra);
  const { exitCode, message, hint } = CONTROL_OUTCOMES[control.outcome];
  const detail = control.outcome === 'missed' ? '' : `: ${control.why ?? ''}`;
  const failure =
    exitCode === undefined
      ? undefined
      : new FireForgeError(`control-${control.outcome}`, `${message ?? ''}${detail}.`, {
          exitCode,
          ...(hint === undefined ? {} : { hint }),
        });
  return {
    lines: renderControl(control),
    document: controlDocument(control),
    pass,
    fields,
    ...(failure === undefined ? {} : { failure }),
  };
}
