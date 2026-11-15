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
import { build, ensureBuilt, type Workspace } from '../engine/index.js';
import { captureWorktree } from '../git/index.js';
import { toError } from '../kernel/errors.js';
import {
  isInside,
  readBytes,
  readBytesIfExists,
  resolveInside,
  toPosixPath,
} from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
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
  /**
   * The build of the restored engine, when the mutation needed one:
   * `deferred` leaves it to the next control of a {@link ControlSession}, or to
   * {@link settleControls}.
   */
  restoreBuild?: 'done' | 'failed' | 'deferred';
  /** The engine state the control ran against: a tree of the engine's working tree before the mutation. */
  engine?: string;
  /** The assertions that went red with the mutation. */
  red?: string[];
  /** The reds no expected label names. */
  unexpected?: string[];
}

/**
 * What several controls on one workspace share: whether the engine is
 * restored but still built with a mutation, and which tests are proven green
 * on which engine state. Controls run in turn through one session build once
 * for the restored engine instead of once per control.
 */
export interface ControlSession {
  /** The engine holds the original bytes, but the build may still hold a mutation. */
  restoreOwed: boolean;
  /** Plan fingerprint to the engine tree its tests were green on. */
  green: Map<string, string>;
  /** Plan fingerprint to the unmutated run {@link proveBaselines} made of it, and the engine tree it ran on. */
  baselines: Map<string, { engine: string; result: TestRunResult }>;
}

/** An empty {@link ControlSession}. */
export function controlSession(): ControlSession {
  return { restoreOwed: false, green: new Map(), baselines: new Map() };
}

/** A red at an assertion that should have passed, as opposed to an unexpected pass. */
const isAssertionFailure = (entry: AssertionFailure): boolean =>
  ['FAIL', 'ERROR'].includes(entry.status) && ['PASS', 'OK'].includes(entry.expected);

/** The reds of a run that were expected to pass. */
function assertionFailures(run: TestRunResult): AssertionFailure[] {
  return run.dispatches.flatMap((dispatch) =>
    dispatch.files.flatMap((file) => file.failures.filter(isAssertionFailure))
  );
}

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
 * Everything of a plan that decides how its tests run, so two plans with the
 * same fingerprint prove the same thing.
 */
function planKey(plan: TestPlan): string {
  return hash(
    JSON.stringify({
      tests: plan.tests.map((test) => test.path),
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
 * Runs a negative control: the tests green without the mutation, then red
 * exactly at the expected assertions with it. Call it while holding the
 * workspace.
 *
 * With a `session`, the build of the restored engine is left to whoever
 * builds next: the next control's mutated run builds the restored engine and
 * its own mutation in one step, and {@link settleControls} builds it when no
 * control follows. Tests proven green earlier in the session on the same
 * engine state are not run again.
 *
 * @param workspace - The workspace
 * @param plan - The tests that must catch the mutation
 * @param request - The diff and the labels
 * @param options - As for `runTests`; the mutated run always builds what it needs
 * @param session - Shared by the controls of one run on this workspace
 * @throws `negative-control` when the diff cannot be read or applied, and what `runTests` throws
 */
export async function runControl(
  workspace: Workspace,
  plan: TestPlan,
  request: ControlRequest,
  options: RunOptions = {},
  session?: ControlSession
): Promise<ControlResult> {
  if (request.expect.length === 0)
    throw refusal('negative-control', 'A control names at least one expected assertion.');
  const targets = await readTargets(workspace, request.diff, request.roots ?? []);
  const paths = targets.map((target) => target.path);
  const engine = await captureWorktree(workspace.engineDir);
  const key = planKey(plan);
  const baseline = await unmutatedRun(workspace, plan, { engine, session, options });
  const refused = baseline === undefined ? undefined : baselineRefusal(baseline, paths, engine);
  if (refused !== undefined) return refused;
  session?.green.set(key, engine);
  const journal = join(workspace.stateDir, 'journals', 'negative-control');
  if (session !== undefined) session.restoreOwed = true;
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
  const restoreBuild: ControlResult['restoreBuild'] =
    mutated.built === undefined
      ? undefined
      : session === undefined
        ? await rebuild(workspace, options)
        : 'deferred';
  // The mutated run built whatever was stale, the restored engine included.
  if (session !== undefined) session.restoreOwed = mutated.built !== undefined;
  const failures = assertionFailures(mutated);
  const base = {
    ...(baseline === undefined ? {} : { baseline }),
    mutated,
    targets: paths,
    engine,
    red: [...new Set(failures.map((entry) => entry.assertion))],
    unexpected: [
      ...new Set(judgeLabels(request.expect, failures).unrelated.map((entry) => entry.assertion)),
    ],
    ...(restoreBuild === undefined ? {} : { restoreBuild }),
  };
  return judgeMutated(request.expect, mutated, base);
}

/** How the unmutated run of a control's tests stands: an earlier proof, a recorded green, or a run now. */
async function unmutatedRun(
  workspace: Workspace,
  plan: TestPlan,
  context: { engine: string; session: ControlSession | undefined; options: RunOptions }
): Promise<TestRunResult | undefined> {
  const { engine, session, options } = context;
  const key = planKey(plan);
  const proven = session?.baselines.get(key);
  if (proven?.engine === engine) return proven.result;
  if (session?.green.get(key) === engine) {
    info('These tests were green on this engine state earlier in this run; they are not repeated.');
    return undefined;
  }
  if (await isRecordedGreen(workspace, plan)) {
    info('These tests are recorded green on this engine state; the unmutated run is not repeated.');
    return undefined;
  }
  info('Running the tests without the mutation first: a control needs them green.');
  // A mutated build an earlier control left is rebuilt by this run, which needs the restored engine.
  const owed = session?.restoreOwed === true;
  const baseline = await runTests(workspace, plan, owed ? { ...options, build: true } : options);
  if (session !== undefined && baseline.built !== undefined) session.restoreOwed = false;
  return baseline;
}

/** The result of a control whose tests are not green without the mutation, or undefined when they are. */
function baselineRefusal(
  baseline: TestRunResult,
  targets: string[],
  engine: string
): ControlResult | undefined {
  if (baseline.reason === 'inconclusive') {
    const why = 'the engine changed while the tests ran without the mutation';
    return { outcome: 'inconclusive', why, baseline, targets, engine };
  }
  if (baseline.pass) return undefined;
  return {
    outcome: 'baseline-red',
    why: `the tests are not green without the mutation (reason=${baseline.reason ?? 'unknown'}), so a red says nothing about it`,
    baseline,
    targets,
    engine,
  };
}

/** The outcome of a control from its mutated run. */
function judgeMutated(
  expect: readonly string[],
  mutated: TestRunResult,
  base: Omit<ControlResult, 'outcome' | 'why'>
): ControlResult {
  if (mutated.pass) {
    return { ...base, outcome: 'missed', why: 'the tests stayed green with the mutation applied' };
  }
  if (mutated.reason === 'inconclusive') {
    const why = 'the engine changed while the tests ran with the mutation';
    return { ...base, outcome: 'inconclusive', why };
  }
  if (mutated.reason !== 'test-failures') {
    const wanted = expect.map((label) => JSON.stringify(label)).join(', ');
    return {
      ...base,
      outcome: 'wrong-red',
      why: `expected ${wanted}; the run failed with reason=${mutated.reason ?? 'unknown'} instead of failing assertions`,
    };
  }
  const refused = labelRefusal(expect, mutated);
  return refused === undefined
    ? { ...base, outcome: 'caught' }
    : { ...base, outcome: 'wrong-red', why: refused };
}

/**
 * Runs the unmutated tests of every plan not yet known green, on the engine
 * and the build as they are, before any control of a run mutates anything.
 * A control that follows finds its baseline in the session, so no baseline
 * needs the engine rebuilt between two mutations. Call it while holding the
 * workspace, with the build fresh.
 *
 * @param workspace - The workspace
 * @param plans - The plans of the controls about to run
 * @param session - The session those controls run through
 * @param options - As for `runTests`
 * @throws What `runTests` throws, such as `build-stale`; the controls then run their own baselines
 */
export async function proveBaselines(
  workspace: Workspace,
  plans: readonly TestPlan[],
  session: ControlSession,
  options: RunOptions = {}
): Promise<void> {
  const engine = await captureWorktree(workspace.engineDir);
  for (const plan of plans) {
    const key = planKey(plan);
    if (session.baselines.get(key)?.engine === engine || session.green.get(key) === engine) {
      continue;
    }
    if (await isRecordedGreen(workspace, plan)) {
      session.green.set(key, engine);
      continue;
    }
    info('Running the tests of a control without its mutation first.');
    const result = await runTests(workspace, plan, options);
    session.baselines.set(key, { engine, result });
    if (result.pass) session.green.set(key, engine);
  }
}

/**
 * Builds the restored engine when a {@link ControlSession} left it owed: after
 * the last control of a run, and before anything else uses the build.
 *
 * @param workspace - The workspace
 * @param session - The session the controls ran through
 * @param options - `waitMs` is for the host build slot
 * @returns Undefined when nothing was owed; otherwise how the build came out
 */
export async function settleControls(
  workspace: Workspace,
  session: ControlSession,
  options: RunOptions = {}
): Promise<'done' | 'failed' | undefined> {
  if (!session.restoreOwed) return undefined;
  session.restoreOwed = false;
  try {
    info('Building the restored engine, so the workspace keeps no mutated build.');
    await ensureBuilt(workspace, { build: true, waitMs: options.waitMs });
    return 'done';
  } catch (error: unknown) {
    warn(
      `The build of the restored engine failed (${toError(error).message}); its staleness keeps the mutated build from being tested.`
    );
    return 'failed';
  }
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
