// SPDX-License-Identifier: EUPL-1.2
/**
 * Negative controls: proof that tests catch what they claim to. A control
 * applies a reviewed mutation to the engine, builds what the mutation needs,
 * runs the tests, and requires them to go red exactly at the expected
 * assertions. Then every byte is put back.
 *
 * A control means something only if the same tests are green without the
 * mutation, so the unmutated tests run first, unless the workspace recorded
 * a green run of exactly these tests on exactly this engine state.
 *
 * The mutation lives inside a journal transaction: a failure, a signal or a
 * crash restores the engine (a crash on the next transaction over the same
 * journal). When the mutation needed a build, the restored engine is built
 * again so the workspace does not keep a mutated binary; if that build
 * fails, the build's staleness still refuses any test of it.
 */
import { join, relative } from 'node:path';

import { applyFileDiff, parsePatch } from '../diff/index.js';
import { build, type Workspace } from '../engine/index.js';
import { toError } from '../kernel/errors.js';
import {
  isInside,
  readBytes,
  readBytesIfExists,
  resolveInside,
  toPosixPath,
} from '../kernel/fs.js';
import { transaction } from '../kernel/journal.js';
import { info, warn } from '../kernel/log.js';
import { refusal, type TestPlan } from './plan.js';
import type { AssertionFailure } from './rawLog.js';
import { isRecordedGreen, type RunOptions, runTests, type TestRunResult } from './run.js';

/**
 * How a control came out: `caught` (red at exactly the expected assertions),
 * `missed` (green with the mutation), `wrong-red` (red with the mutation, but
 * not at exactly the expected assertions), `baseline-red` (red without the
 * mutation), or `inconclusive` (the engine changed under one of its runs).
 */
export type ControlOutcome = 'caught' | 'missed' | 'wrong-red' | 'baseline-red' | 'inconclusive';

/** What a control asks. */
export interface ControlRequest {
  /**
   * Absolute path of the diff holding the mutation. A path inside names an
   * engine file: engine-relative, under `engine/`, or under one of `roots`.
   */
  diff: string;
  /** Labels of the reds the mutation must produce, every one and no other. */
  expect: readonly string[];
  /**
   * Directories of the checkout whose files the engine holds, so a diff
   * taken from the checkout (`git diff`) names engine files.
   */
  roots?: readonly MutationRoot[];
}

/** A checkout directory and the engine directory its files are found in. */
export interface MutationRoot {
  /** Project-relative directory, such as `src` or `components/custom/moz-card`. */
  readonly directory: string;
  /** Engine-relative directory; empty for the engine's top. */
  readonly engine: string;
}

/** What a control did. */
export interface ControlResult {
  outcome: ControlOutcome;
  /** Why it is not `caught`. */
  why?: string;
  /** The unmutated run; absent when a recorded green run of the same tests and engine stood in. */
  baseline?: TestRunResult;
  /** The mutated run. */
  mutated?: TestRunResult;
  /** Engine paths the mutation changed. */
  targets: string[];
  /** The build of the restored engine, when the mutation needed one. */
  restoreBuild?: 'done' | 'failed';
}

/** A red at an assertion that should have passed, as opposed to an unexpected pass. */
const isAssertionFailure = (entry: AssertionFailure): boolean =>
  ['FAIL', 'ERROR'].includes(entry.status) && ['PASS', 'OK'].includes(entry.expected);

/**
 * Whether a control's label names a red: its assertion (a mochitest's
 * message, an xpcshell task), its whole xpcshell message, or that message
 * without the ` - <actual> <operator> <expected>` details `Assert` adds.
 *
 * @param entry - The red
 * @param label - The label
 */
export function matchesLabel(entry: AssertionFailure, label: string): boolean {
  if (entry.assertion === label) return true;
  return (
    entry.message !== undefined &&
    (entry.message === label || entry.message.startsWith(`${label} - `))
  );
}

/**
 * Judges a control's labels against the reds it produced: every label met
 * and every red named.
 *
 * @param expected - The labels
 * @param failures - The failing assertions
 */
export function judgeLabels(
  expected: readonly string[],
  failures: readonly AssertionFailure[]
): { matched: boolean; missing: string[]; unrelated: AssertionFailure[] } {
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

/** Each red's labels, as a person would copy them into `--expect`. */
export function describeLabels(failures: readonly AssertionFailure[]): string {
  if (failures.length === 0) return 'no failing assertion';
  const shown = failures.map((entry) =>
    entry.message === undefined
      ? JSON.stringify(entry.assertion)
      : `${JSON.stringify(entry.assertion)} (assertion ${JSON.stringify(entry.message)})`
  );
  return [...new Set(shown)].join(', ');
}

/**
 * Why a mutated run does not prove the labels, or undefined when it does:
 * every label met and no red unnamed, over the run and in each repetition.
 *
 * @param expected - The labels
 * @param run - The mutated run
 */
export function labelRefusal(expected: readonly string[], run: TestRunResult): string | undefined {
  const failuresOf = (repetition?: number): AssertionFailure[] =>
    run.dispatches
      .filter((dispatch) => repetition === undefined || dispatch.run === repetition)
      .flatMap((dispatch) =>
        dispatch.files.flatMap((file) => file.failures.filter(isAssertionFailure))
      );
  const wanted = expected.map((label) => JSON.stringify(label)).join(', ');
  const all = failuresOf();
  if (!judgeLabels(expected, all).matched) {
    return `expected ${wanted}; the run was red at ${describeLabels(all)}`;
  }
  for (let repetition = 1; repetition <= run.plan.repeat; repetition += 1) {
    const reds = failuresOf(repetition);
    if (judgeLabels(expected, reds).missing.length > 0) {
      return `expected ${wanted} in every repetition; repetition ${repetition} was red at ${describeLabels(reds)}`;
    }
  }
  return undefined;
}

/** One file the mutation changes: its bytes before and with the mutation (undefined: absent). */
interface Target {
  path: string;
  absolute: string;
  original: Buffer | undefined;
  mutated: Buffer | undefined;
}

/**
 * The engine file a diff section mutates. The old side names it: a diff made
 * with `git diff --no-index <engine file> <edited copy>` names the copy on
 * its new side. An absolute path loses its leading slash under `a/`, and a
 * project-relative one starts with `engine/`.
 */
function enginePath(written: string, workspace: Workspace, roots: readonly MutationRoot[]): string {
  const absolute = `/${written}`;
  if (isInside(workspace.engineDir, absolute))
    return toPosixPath(relative(workspace.engineDir, absolute));
  // The longest directory wins: a component directory may lie inside another root.
  const root = [...roots]
    .sort((a, b) => b.directory.length - a.directory.length)
    .find((candidate) => written.startsWith(`${candidate.directory}/`));
  if (root !== undefined) {
    const rest = written.slice(root.directory.length + 1);
    return root.engine === '' ? rest : `${root.engine}/${rest}`;
  }
  return written.replace(/^engine\//, '');
}

async function readTargets(
  workspace: Workspace,
  diff: string,
  roots: readonly MutationRoot[]
): Promise<Target[]> {
  let patch;
  try {
    patch = parsePatch(await readBytes(diff));
  } catch (error: unknown) {
    throw refusal(
      'negative-control',
      `Cannot read the control diff ${diff}: ${toError(error).message}`
    );
  }
  if (patch.files.length === 0) throw refusal('negative-control', `${diff} changes no file.`);
  const targets: Target[] = [];
  for (const file of patch.files) {
    if (file.status === 'renamed' || file.status === 'copied' || file.binary !== undefined) {
      throw refusal(
        'negative-control',
        `${diff}: ${file.path} is a rename, copy or binary change; a control edits text in place.`
      );
    }
    const path = enginePath(
      file.status === 'added' ? file.newPath : file.oldPath,
      workspace,
      roots
    );
    const absolute = resolveInside(workspace.engineDir, path);
    const original = await readBytesIfExists(absolute);
    let mutated: Buffer | undefined;
    try {
      mutated = applyFileDiff(file, original);
    } catch (error: unknown) {
      throw refusal(
        'negative-control',
        `The control does not apply to ${path}: ${toError(error).message}`
      );
    }
    targets.push({ path, absolute, original, mutated });
  }
  return targets;
}

/**
 * Runs a negative control: the tests green without the mutation, then red
 * exactly at the expected assertions with it. Call it while holding the
 * workspace.
 *
 * @param workspace - The workspace
 * @param plan - The tests that must catch the mutation
 * @param request - The diff and the labels
 * @param options - As for `runTests`; the mutated run always builds what it needs
 * @throws `negative-control` when the diff cannot be read or applied, and what `runTests` throws
 */
export async function runControl(
  workspace: Workspace,
  plan: TestPlan,
  request: ControlRequest,
  options: RunOptions = {}
): Promise<ControlResult> {
  if (request.expect.length === 0)
    throw refusal('negative-control', 'A control names at least one expected assertion.');
  const targets = await readTargets(workspace, request.diff, request.roots ?? []);
  const paths = targets.map((target) => target.path);
  let baseline: TestRunResult | undefined;
  if (await isRecordedGreen(workspace, plan)) {
    info('These tests are recorded green on this engine state; the unmutated run is not repeated.');
  } else {
    info('Running the tests without the mutation first: a control needs them green.');
    baseline = await runTests(workspace, plan, options);
    if (baseline.reason === 'inconclusive') {
      const why = 'the engine changed while the tests ran without the mutation';
      return { outcome: 'inconclusive', why, baseline, targets: paths };
    }
    if (!baseline.pass) {
      return {
        outcome: 'baseline-red',
        why: `the tests are not green without the mutation (reason=${baseline.reason ?? 'unknown'}), so a red says nothing about it`,
        baseline,
        targets: paths,
      };
    }
  }
  const journal = join(workspace.stateDir, 'journals', 'negative-control');
  const mutated = await transaction(journal, 'a negative control', async (tx) => {
    for (const target of targets) {
      if (target.mutated === undefined) await tx.remove(target.absolute);
      else await tx.write(target.absolute, target.mutated);
    }
    info(`Applied the control to ${paths.join(', ')}.`);
    try {
      return await runTests(workspace, plan, { ...options, build: true });
    } finally {
      for (const target of targets) {
        if (target.original === undefined) await tx.remove(target.absolute);
        else await tx.write(target.absolute, target.original);
      }
      info('Restored the engine.');
    }
  });
  const restoreBuild = mutated.built === undefined ? undefined : await rebuild(workspace, options);
  const base = {
    ...(baseline === undefined ? {} : { baseline }),
    mutated,
    targets: paths,
    ...(restoreBuild === undefined ? {} : { restoreBuild }),
  };
  if (mutated.pass) {
    return { ...base, outcome: 'missed', why: 'the tests stayed green with the mutation applied' };
  }
  if (mutated.reason === 'inconclusive') {
    const why = 'the engine changed while the tests ran with the mutation';
    return { ...base, outcome: 'inconclusive', why };
  }
  if (mutated.reason !== 'test-failures') {
    const wanted = request.expect.map((label) => JSON.stringify(label)).join(', ');
    return {
      ...base,
      outcome: 'wrong-red',
      why: `expected ${wanted}; the run failed with reason=${mutated.reason ?? 'unknown'} instead of failing assertions`,
    };
  }
  const refused = labelRefusal(request.expect, mutated);
  return refused === undefined
    ? { ...base, outcome: 'caught' }
    : { ...base, outcome: 'wrong-red', why: refused };
}

async function rebuild(workspace: Workspace, options: RunOptions): Promise<'done' | 'failed'> {
  try {
    info('Building the restored engine, so the workspace keeps no mutated build.');
    await build(workspace, { ui: true, waitMs: options.waitMs });
    return 'done';
  } catch (error: unknown) {
    warn(
      `The build of the restored engine failed (${toError(error).message}); its staleness keeps the mutated build from being tested.`
    );
    return 'failed';
  }
}
