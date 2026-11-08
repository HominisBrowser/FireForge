// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';

import { CONTROL_BASELINE_REPETITION } from '../../commands/test-multi-verdict.js';
import type { TestResultsDocument } from '../../commands/test-results.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { capturedControlDigest } from './captured-inputs.js';
import type { JobStep, StepEvidence } from './schema.js';
import { requestedTestRepeats } from './test-repeats.js';

export { executorFingerprint } from './executor-fingerprint.js';

/**
 * What in a job's environment can change what a browser or a project script does,
 * with no value in it that names a job, a slot, a host path or a credential: equal
 * environments have equal digests across jobs, slots and steps. Node is not here:
 * it runs FireForge and project scripts, not a browser, and the quality digest binds
 * its bytes. What a PATH or a tool variable reaches is bound by the tool digests,
 * and a job inherits no `MOZ_*` from a client.
 */
export function executionEnvironmentDigest(): string {
  const values = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'].flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  });
  return createHash('sha256')
    .update(
      JSON.stringify({
        platform: platform(),
        arch: arch(),
        kernel: release(),
        values,
      })
    )
    .digest('hex');
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^engine\//, '');
}
function sameRoster(expected: readonly string[], actual: readonly string[]): boolean {
  const matches = (path: string, candidate: string): boolean =>
    normalize(candidate) === normalize(path) ||
    normalize(candidate).endsWith(`/${normalize(path)}`);
  return (
    expected.length === actual.length &&
    expected.every((path) => actual.filter((candidate) => matches(path, candidate)).length === 1) &&
    actual.every((candidate) => expected.filter((path) => matches(path, candidate)).length === 1)
  );
}

/** Validate exact started/completed files per repeat; a red, a skip or an unfinished file never becomes proof. */
export async function testStepEvidence(
  step: JobStep,
  path: string,
  snapshot?: AuthoredSnapshot
): Promise<
  Pick<
    StepEvidence,
    'selectedFiles' | 'completedRuns' | 'resultDigest' | 'control' | 'controlProof'
  >
> {
  const bytes = await readFile(path);
  const results = JSON.parse(bytes.toString()) as TestResultsDocument;
  const expected = step.expected;
  if (expected === undefined || results.dispatches === undefined || results.unfinished.length > 0)
    throw new Error('Incomplete structured test dispatch evidence');
  const repeatCount = requestedTestRepeats(step.args);
  // A control's unmutated baseline is rostered below like any dispatch, but it is not one of its runs.
  const runs = new Set(
    results.dispatches
      .map((dispatch) => dispatch.run)
      .filter((run) => run !== CONTROL_BASELINE_REPETITION)
  );
  if (
    !Number.isSafeInteger(repeatCount) ||
    repeatCount < 1 ||
    runs.size !== repeatCount ||
    [...runs].some((run) => !Number.isSafeInteger(run) || run < 1 || run > repeatCount)
  )
    throw new Error('Test repeat roster does not match requested count');
  const requested = results.dispatches.flatMap((dispatch) => dispatch.requested);
  const selected = [...new Set(expected.files)];
  // Repeats are validated individually, so a later pass cannot hide an earlier missing file.
  for (const run of new Set(results.dispatches.map((dispatch) => dispatch.run))) {
    const dispatches = results.dispatches.filter((dispatch) => dispatch.run === run);
    if (
      !sameRoster(
        selected,
        dispatches.flatMap((dispatch) => dispatch.requested)
      ) ||
      dispatches.some((dispatch) => dispatch.skipped.length > 0) ||
      !sameRoster(
        selected,
        dispatches.flatMap((dispatch) => dispatch.started)
      ) ||
      !sameRoster(
        selected,
        dispatches.flatMap((dispatch) => dispatch.completed)
      ) ||
      dispatches.some((dispatch) => dispatch.unfinished.length > 0 || dispatch.attempts < 1)
    )
      throw new Error('Selected/started/completed test roster mismatch');
  }
  if (results.dispatches.length === 0 || requested.length === 0)
    throw new Error('Required file evidence unavailable');
  const control = await validateControlEvidence(step, results, snapshot);
  if (control === undefined && results.files.some((file) => file.unexpected))
    throw new Error('A grouped test red cannot be erased by another pass');
  return {
    selectedFiles: selected,
    completedRuns: [...runs].sort((a, b) => a - b),
    resultDigest: createHash('sha256').update(bytes).digest('hex'),
    ...(control === undefined ? {} : { control: 'caught' as const, controlProof: control }),
  };
}

/** A red control needs its exact expected labels, verified mutation bytes and exact restoration. */
async function validateControlEvidence(
  step: JobStep,
  results: TestResultsDocument,
  snapshot?: AuthoredSnapshot
): Promise<StepEvidence['controlProof']> {
  const diffDigest = await capturedControlDigest(snapshot, step);
  if (diffDigest === undefined) return undefined;
  const expected = [...new Set(step.controlAssertions ?? [])].sort();
  const actual = [
    ...new Set(
      results.files.flatMap((file) =>
        (file.unexpectedAssertionResults ?? [])
          .filter(
            (entry) =>
              ['FAIL', 'ERROR'].includes(entry.status) && ['PASS', 'OK'].includes(entry.expected)
          )
          .map((entry) => entry.assertion)
      )
    ),
  ].sort();
  if (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error('Negative control failed at an unexpected assertion');
  for (const file of results.files.filter((entry) => entry.unexpected)) {
    const assertions = file.unexpectedAssertionResults ?? [];
    if (
      (step.expected?.files ?? []).filter(
        (path) =>
          normalize(file.test) === normalize(path) ||
          normalize(file.test).endsWith(`/${normalize(path)}`)
      ).length !== 1 ||
      !['PASS', 'OK', 'FAIL'].includes(file.status) ||
      (file.status !== file.expected &&
        !(file.status === 'FAIL' && ['PASS', 'OK'].includes(file.expected))) ||
      assertions.length === 0 ||
      file.unexpectedSubtests !== assertions.length ||
      assertions.some(
        (entry) =>
          !expected.includes(entry.assertion) ||
          !['FAIL', 'ERROR'].includes(entry.status) ||
          !['PASS', 'OK'].includes(entry.expected)
      )
    )
      throw new Error('Negative control contains an unrelated unexpected result');
  }
  const controls = results.controls;
  if (
    !controls?.length ||
    controls.some(
      (control) =>
        control.diffDigest !== diffDigest ||
        !control.mutationVerified ||
        !control.restored ||
        (control.compiled && control.compiledRestoreBuild !== 'done') ||
        control.targets.length === 0 ||
        control.targets.some(
          (target) =>
            target.restoredSha256 !== target.originalSha256 ||
            target.restoredMode !== target.mode ||
            !/^[a-f0-9]{64}$/.test(target.mutatedSha256)
        )
    )
  )
    throw new Error('Negative control mutation or restore evidence is incomplete');
  for (const run of new Set(results.dispatches?.map((dispatch) => dispatch.run))) {
    if (run === CONTROL_BASELINE_REPETITION) continue;
    if (!controls.some((control) => control.run === run))
      throw new Error('Negative control lacks mutation evidence for a dispatched repeat');
    const assertions = new Set(
      results.files
        .filter((file) => file.run === run)
        .flatMap((file) =>
          (file.unexpectedAssertionResults ?? [])
            .filter(
              (entry) =>
                ['FAIL', 'ERROR'].includes(entry.status) && ['PASS', 'OK'].includes(entry.expected)
            )
            .map((entry) => entry.assertion)
        )
    );
    if (assertions.size !== expected.length || expected.some((label) => !assertions.has(label)))
      throw new Error('Negative control lacks intended failing assertions for a dispatched repeat');
  }
  return { expectedAssertions: expected, actualAssertions: actual, mutations: controls };
}
