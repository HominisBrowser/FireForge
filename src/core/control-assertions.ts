// SPDX-License-Identifier: EUPL-1.2
/**
 * Whether a negative control reddened where it said it would.
 *
 * A control names the assertions its mutation has to redden. A red is
 * labelled by mozlog's `subtest`: a mochitest's assertion message, an
 * xpcshell test's task name. An xpcshell red also carries the assertion's
 * own message, `<message> - <actual> <operator> <expected>` for an `Assert`
 * call, which the results file records as `message`. A label matches a red
 * when it is its `subtest`, or its whole `message`, or that message up to the
 * ` - ` the `Assert` details follow.
 *
 * `fireforge test` and the job that judges its evidence both decide with
 * {@link judgeControlLabels}, so the verdict line cannot read `control=caught`
 * where the proof refuses the labels.
 */

/** Where a job hands a control step the labels its proof expects. */
export const CONTROL_ASSERTIONS_ENV = 'FIREFORGE_CONTROL_ASSERTIONS';

/** One unexpected `test_status` record, as the results file keeps it. */
export interface AssertionResult {
  /** mozlog's `subtest`: the assertion (mochitest) or the task (xpcshell). */
  assertion: string;
  status: string;
  expected: string;
  /** The assertion's own message, where the harness states it apart from the label. */
  message?: string;
}

/** A failing assertion that should have passed, as opposed to an unexpected pass. */
export const isAssertionFailure = (entry: AssertionResult): boolean =>
  ['FAIL', 'ERROR'].includes(entry.status) && ['PASS', 'OK'].includes(entry.expected);

/** Whether a control's label names this red. */
export function matchesLabel(entry: AssertionResult, label: string): boolean {
  if (entry.assertion === label) return true;
  const { message } = entry;
  return message !== undefined && (message === label || message.startsWith(`${label} - `));
}

/** How a control's labels met its reds. */
export interface ControlLabelJudgement {
  /** Every label met a red and every red met a label. */
  matched: boolean;
  /** Labels no red answered. */
  missing: string[];
  /** Reds no label named. */
  unrelated: AssertionResult[];
}

/**
 * Judges a control's expected labels against the failing assertions it produced.
 *
 * @param expected - The labels the control names
 * @param failures - The failing assertions, see {@link isAssertionFailure}
 */
export function judgeControlLabels(
  expected: readonly string[],
  failures: readonly AssertionResult[]
): ControlLabelJudgement {
  const missing = expected.filter((label) => !failures.some((entry) => matchesLabel(entry, label)));
  const unrelated = failures.filter(
    (entry) => !expected.some((label) => matchesLabel(entry, label))
  );
  return {
    matched: expected.length > 0 && missing.length === 0 && unrelated.length === 0,
    missing,
    unrelated,
  };
}

/** Each red's labels as a person can copy them into `--expect`. */
export function describeLabels(failures: readonly AssertionResult[]): string {
  if (failures.length === 0) return 'no failing assertion';
  const shown = [
    ...new Set(
      failures.map((entry) =>
        entry.message === undefined
          ? JSON.stringify(entry.assertion)
          : `${JSON.stringify(entry.assertion)} (assertion ${JSON.stringify(entry.message)})`
      )
    ),
  ];
  return shown.join(', ');
}

/**
 * The refusal for a control that reddened elsewhere, naming what it expected
 * and every label the reds carried.
 */
function unexpectedAssertionMessage(
  expected: readonly string[],
  failures: readonly AssertionResult[]
): string {
  return `Negative control failed at an unexpected assertion: expected ${expected
    .map((label) => JSON.stringify(label))
    .join(', ')}; the reds were labelled ${describeLabels(failures)}`;
}

/** A file's record as both the results file and the job's evidence read it. */
export interface ControlFileResult {
  run: number;
  unexpectedAssertionResults?: AssertionResult[];
}

/**
 * Why a control's reds do not prove its labels, or undefined when they do: every
 * label met by a red and no red unnamed, overall and in each repeat.
 *
 * @param expected - The labels the control names
 * @param files - The mutated runs' file records
 */
export function controlLabelRefusal(
  expected: readonly string[],
  files: readonly ControlFileResult[]
): string | undefined {
  const failuresOf = (records: readonly ControlFileResult[]): AssertionResult[] =>
    records.flatMap((file) => (file.unexpectedAssertionResults ?? []).filter(isAssertionFailure));
  const failures = failuresOf(files);
  if (!judgeControlLabels(expected, failures).matched)
    return unexpectedAssertionMessage(expected, failures);
  for (const run of new Set(files.map((file) => file.run))) {
    const repeat = failuresOf(files.filter((file) => file.run === run));
    if (judgeControlLabels(expected, repeat).missing.length > 0)
      return 'Negative control lacks intended failing assertions for a dispatched repeat';
  }
  return undefined;
}
