// SPDX-License-Identifier: EUPL-1.2
/**
 * `gate`: the check and the declared tests on a clean committed tree, and
 * the ref that says which commit last passed them.
 *
 * A full run holds one workspace and does, in order: `check`, component
 * deployment, the build, then every declared lane, stress run, negative
 * control and smoke start. A red entry does not stop the ones after it, so
 * one run reports everything; after a red build nothing else can mean
 * anything and the rest is skipped. The run's logs and outputs go under
 * `.fireforge/gate/<commit>/` with the result.
 *
 * `refs/fireforge/verified` moves to the commit, by compare-and-swap against
 * the value it had when the gate started and fast-forward only, when every
 * entry passed and every declared acceptance is recorded for the commit's
 * tree. A passed run whose acceptances are outstanding is `pending`; the
 * next gate reads the recorded pass instead of running again. A commit that
 * differs from the verified one only in `gate.documents` paths needs `check`
 * alone; one that also changes the diff file of a declared control, or
 * `gate.controls`, needs `check`, the build and the controls that changed.
 *
 * An entry that could not judge the commit (a lock that did not come free,
 * an engine that changed under it) is `blocked`, not red: the gate exits with
 * the code of that failure instead of reading the commit as bad.
 */
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { usageError } from '../cli/command.js';
import { ARTIFACTS_PLACEHOLDER, type GateConfig, type GateLane } from '../config/index.js';
import { build, runBrowser, type Workspace } from '../engine/index.js';
import { getConfig, git, isAncestor, resolveRevision, status, updateRef } from '../git/index.js';
import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { ensureDir, readBytesIfExists, remove } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { info, step, verbose } from '../kernel/log.js';
import { run } from '../kernel/process/index.js';
import { formatDuration } from '../kernel/time.js';
import { deployComponents, mutationRoots, withWorkspace } from '../mode/index.js';
import type { Project } from '../project/index.js';
import {
  controlReport,
  type ControlSession,
  controlSession,
  planTests,
  proveBaselines,
  recordControlRun,
  runControl,
  runReport,
  runTests,
  settleControls,
  type TestPlan,
  validatorEnvironment,
  writeResults,
} from '../test/index.js';
import { type CheckReport, runCheck } from './check.js';
import { lightChange, type OwedControl, owedControls } from './controls.js';
import { type LoadSample, sampleLoad } from './hostLoad.js';
import { attributeLoad, renderLoad } from './load.js';
import {
  type Acceptance,
  type Blocked,
  declarationHash,
  dropResult,
  gateDir,
  type GateEntry,
  type GateLoad,
  hasArtifacts,
  openRunRecord,
  prepareGateDir,
  readAcceptances,
  readResult,
  readResumable,
  readRunningGates,
  recordAcceptance,
  type Resumable,
  type RunningGate,
  type RunRecorder,
  VERIFIED_REF,
  withFeedbackDir,
  withGateRun,
  writeResult,
} from './record.js';

/** How {@link runGate} runs. */
export interface GateOptions {
  /** Run only these declared entries, for feedback: nothing is recorded and the ref stays. */
  only?: readonly string[];
  /** Let the verified ref move to a commit that does not descend from the one it holds. */
  allowRewrite?: boolean | undefined;
  /** Source mode: lease this pool workspace. */
  workspace?: string | undefined;
  /** How long to wait for the workspace and the host locks, in milliseconds. */
  waitMs?: number | undefined;
  /**
   * Take the passes of the last full run of this commit, tree, FireForge
   * version and gate declaration instead of running those entries again.
   */
  resume?: boolean | undefined;
}

/** What a gate invocation came to. */
export interface GateReport {
  /**
   * `verified`: the ref is at the commit. `pending`: everything passed and
   * acceptances are outstanding. `failed`: an entry is red. `feedback`: a
   * subset ran (see `pass`).
   */
  outcome: 'verified' | 'pending' | 'failed' | 'feedback';
  /**
   * Where the entries come from: a run now, the result recorded for this
   * commit, the check alone for a documents-only commit, the check, the build
   * and the controls that changed for a commit that changes only documents,
   * control diffs and `gate.controls`, or nothing because the ref was already
   * there.
   */
  basis: 'run' | 'recorded' | 'documents' | 'controls' | 'already-verified' | 'feedback';
  pass: boolean;
  /** The gated commit and its tree; absent for feedback, which runs on the working tree. */
  commit?: string;
  tree?: string;
  entries: GateEntry[];
  /** The check of this invocation, when it ran. */
  check?: CheckReport;
  /** Declared acceptances the tree still needs, by ID. */
  pending: string[];
  /** Where logs and outputs are, when anything ran. */
  artifacts?: string;
  /** Declared controls with no standing proof in this checkout, each with why. */
  owed: OwedControl[];
  /** Present when the run was asked to resume: the entries taken from the earlier run, and why none were when it could not. */
  resume?: { reused: string[]; why?: string };
}

interface Head {
  /** The top directory of the repository's working tree. */
  repository: string;
  commit: string;
  tree: string;
}

/** The project's checked-out commit. */
async function headCommit(project: Project): Promise<Head> {
  const repository = project.checkout.worktree;
  const commit =
    repository === undefined ? undefined : await resolveRevision(repository, 'HEAD', 'commit');
  if (repository === undefined || commit === undefined) {
    throw new FireForgeError('gate-no-commit', 'The gate judges a commit, and there is none.', {
      exitCode: ExitCode.GIT_ERROR,
      hint: 'Commit the project to a git repository first.',
    });
  }
  const tree = await resolveRevision(repository, commit, 'tree');
  return { repository, commit, tree: tree ?? '' };
}

/** The project's checked-out commit, refused unless the working tree equals it. */
async function cleanHead(project: Project): Promise<Head> {
  const head = await headCommit(project);
  const dirty = (await status(head.repository)).map((entry) => entry.path);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 20).join('\n  ');
    throw new FireForgeError(
      'gate-dirty-tree',
      `The gate judges a commit, and the working tree differs from it in ${dirty.length} path(s):\n  ${shown}` +
        (dirty.length > 20 ? `\n  and ${dirty.length - 20} more` : ''),
      { hint: 'Commit the changes, or remove or ignore the files, then run the gate again.' }
    );
  }
  return head;
}

interface RunContext {
  workspace: Workspace;
  waitMs: number | undefined;
  /** Shared by the controls of this run: one build restores the engine for all of them. */
  session: ControlSession;
  /** How the controls are recorded: a full run, or a feedback subset. */
  source: 'gate' | 'feedback';
  /** The commit and tree of a full run, which the controls record they ran against. */
  head?: { commit: string; tree: string } | undefined;
  /** Where the run records its progress; absent for a feedback run. */
  recorder?: RunRecorder | undefined;
  /** Entries of an earlier run of this commit that stand and are not run again. */
  reuse?: ReadonlyMap<string, GateEntry> | undefined;
}

/** How one declared entry came out. */
interface Judged {
  pass: boolean;
  detail: string;
  /** Set on a red that says nothing about the commit. */
  blocked?: Blocked | undefined;
  /** A negative control's outcome. */
  control?: GateEntry['control'];
}

/** A declared lane, stress run, control or smoke start, ready to run. */
interface Declared {
  /** `kind:id`. */
  id: string;
  /** Runs it with `artifacts` as its private output directory. A thrown error is a red. */
  run: (context: RunContext, artifacts: string) => Promise<Judged>;
  /** For a control: the plan of its tests, so the unmutated runs of several controls happen before the first mutation. */
  plan?: (workspace: Workspace) => Promise<TestPlan>;
}

const expand = (value: string, artifacts: string): string =>
  value.replaceAll(ARTIFACTS_PLACEHOLDER, artifacts);

type Validate = NonNullable<GateLane['validate']>;

const validator = (
  project: Project,
  validate: Validate,
  artifacts: string
): { command: string[]; cwd: string } => ({
  command: validate.command.map((word) => expand(word, artifacts)),
  cwd: project.root,
});

function lane(project: Project, declared: GateLane): Declared['run'] {
  return async ({ workspace, waitMs }, artifacts) => {
    const env = Object.fromEntries(
      Object.entries(declared.env ?? {}).map(([name, value]) => [name, expand(value, artifacts)])
    );
    const uploadDir = join(artifacts, 'upload');
    if (declared.uploadDir) await ensureDir(uploadDir);
    const plan = await planTests(workspace.engineDir, {
      paths: declared.files,
      dispatch: declared.dispatch,
      headed: declared.headed,
      env,
      ...(declared.exclude === undefined ? {} : { exclude: declared.exclude }),
      ...(declared.repeat === undefined ? {} : { repeat: declared.repeat }),
      ...(declared.machArgs === undefined ? {} : { machArgs: declared.machArgs }),
      ...(declared.uploadDir ? { uploadDir } : {}),
      ...(declared.validate === undefined
        ? {}
        : { validate: validator(project, declared.validate, artifacts) }),
    });
    const result = await runTests(workspace, plan, {
      keepLog: join(artifacts, 'output.log'),
      ...(waitMs === undefined ? {} : { waitMs }),
    });
    await writeResults(join(artifacts, 'results.json'), runReport(result).document);
    const files = `${plan.tests.length} test file(s)${plan.repeat > 1 ? ` x ${plan.repeat}` : ''}`;
    return {
      pass: result.pass,
      detail: result.pass ? files : `${files}, reason=${result.reason ?? 'unknown'}`,
      ...(result.reason === 'inconclusive' ? { blocked: 'inconclusive' as const } : {}),
    };
  };
}

function control(
  project: Project,
  declared: NonNullable<GateConfig['controls']>[number]
): Declared['run'] {
  return async ({ workspace, waitMs, session, source, head }, artifacts) => {
    const plan = await planTests(workspace.engineDir, { paths: [declared.test] });
    const diff = join(project.root, declared.diff);
    const result = await runControl(
      workspace,
      plan,
      { diff, expect: declared.assertions, roots: await mutationRoots(project) },
      waitMs === undefined ? {} : { waitMs },
      session
    );
    await recordControlRun(project, {
      source,
      id: declared.id,
      diff,
      tests: [declared.test],
      expect: declared.assertions,
      result,
      against: head,
    });
    await writeResults(join(artifacts, 'results.json'), controlReport(result).document);
    return {
      pass: result.outcome === 'caught',
      detail: result.why === undefined ? result.outcome : `${result.outcome}: ${result.why}`,
      control: result.outcome,
      ...(result.outcome === 'inconclusive' ? { blocked: 'inconclusive' as const } : {}),
    };
  };
}

function smoke(
  project: Project,
  declared: NonNullable<GateConfig['runs']>[number]
): Declared['run'] {
  return async ({ workspace, waitMs }, artifacts) => {
    await runBrowser(workspace, {
      smokeExit: declared.smokeExit,
      headless: declared.headless,
      captureConsole: join(artifacts, 'console.txt'),
      ...(declared.args === undefined ? {} : { args: declared.args }),
      ...(declared.consoleAllowFile === undefined
        ? {}
        : { consoleAllowFile: join(project.root, declared.consoleAllowFile) }),
      ...(waitMs === undefined ? {} : { waitMs }),
    });
    const started = `smoke start of ${declared.smokeExit}s`;
    if (declared.validate === undefined) return { pass: true, detail: started };
    const { command, cwd } = validator(project, declared.validate, artifacts);
    const [program = '', ...args] = command;
    const judged = await run(program, args, {
      cwd,
      env: validatorEnvironment(workspace),
      onLine: info,
    });
    return judged.exitCode === 0
      ? { pass: true, detail: started }
      : { pass: false, detail: `${started}; its validator exited ${judged.exitCode}` };
  };
}

/** Everything the project's gate declares, in the order it runs. */
function declaredEntries(project: Project): Declared[] {
  const gate = project.config.gate;
  return [
    ...(gate?.lanes ?? []).map((entry) => ({ id: `lane:${entry.id}`, run: lane(project, entry) })),
    ...(gate?.stress ?? []).map((entry) => ({
      id: `stress:${entry.id}`,
      run: lane(project, entry),
    })),
    ...(gate?.controls ?? []).map((entry) => ({
      id: `control:${entry.id}`,
      run: control(project, entry),
      plan: (workspace: Workspace) => planTests(workspace.engineDir, { paths: [entry.test] }),
    })),
    ...(gate?.runs ?? []).map((entry) => ({ id: `run:${entry.id}`, run: smoke(project, entry) })),
  ];
}

/** Whether a name selects a declared entry: its `kind:id`, a bare ID, or `kind:*` for every entry of a kind. */
const selects = (entry: Declared, name: string): boolean =>
  entry.id === name ||
  entry.id.endsWith(`:${name}`) ||
  (name.endsWith(':*') && entry.id.startsWith(name.slice(0, -1)));

/** The declared entries an invocation named, in the order the gate runs them. */
function selectEntries(all: readonly Declared[], names: readonly string[]): Declared[] {
  for (const name of names) {
    if (!all.some((entry) => selects(entry, name))) {
      throw usageError(
        `The gate declares no "${name}"`,
        all.length === 0
          ? 'fireforge.json declares no lanes, stress runs, controls or runs under "gate".'
          : `Declared: ${all.map((entry) => entry.id).join(', ')}.`
      );
    }
  }
  return all.filter((entry) => names.some((name) => selects(entry, name)));
}

/** Why a thrown error says nothing about the commit, from the exit code of the failure. */
function blockedBy(error: unknown): Blocked | undefined {
  if (!(error instanceof FireForgeError)) return undefined;
  if (error.exitCode === ExitCode.LOCK_TIMEOUT) return 'lock-timeout';
  return error.exitCode === ExitCode.INCONCLUSIVE ? 'inconclusive' : undefined;
}

/** Whether an error is an interrupt, which ends the gate instead of being an entry's result. */
const isInterrupt = (error: unknown): boolean =>
  error instanceof FireForgeError &&
  (error.exitCode === ExitCode.USER_CANCELLED || error.exitCode === ExitCode.TERMINATED);

/** Says what the host was doing when an interrupt ended an entry, and records it with the run. */
async function noteInterrupt(
  id: string,
  startLoad: LoadSample | undefined,
  recorder: RunRecorder | undefined
): Promise<void> {
  const load = await attributeLoad(startLoad);
  if (load !== undefined) info(`Gate: ${id} was interrupted; ${renderLoad(load)}.`);
  await recorder?.interrupted(id, load);
}

async function timed(
  id: string,
  artifacts: string | undefined,
  body: () => Promise<Judged>,
  recorder?: RunRecorder
): Promise<GateEntry> {
  const startedAt = Date.now();
  const startLoad = sampleLoad();
  step(`Gate: ${id}`);
  await recorder?.begin(id);
  let outcome: Judged;
  let hint: string | undefined;
  try {
    outcome = await body();
  } catch (error: unknown) {
    if (isInterrupt(error)) {
      await noteInterrupt(id, startLoad, recorder);
      throw error;
    }
    outcome = {
      pass: false,
      detail: toError(error).message.split('\n')[0] ?? '',
      blocked: blockedBy(error),
    };
    hint = error instanceof FireForgeError ? error.hint : undefined;
  }
  const load = outcome.pass ? undefined : await attributeLoad(startLoad);
  const entry = finish(id, artifacts, startedAt, outcome, { hint, load });
  await recorder?.complete(entry);
  return entry;
}

function finish(
  id: string,
  artifacts: string | undefined,
  startedAt: number,
  outcome: Judged,
  extra: { hint?: string | undefined; load?: GateLoad | undefined } = {}
): GateEntry {
  const { hint, load } = extra;
  return {
    id,
    status: outcome.pass ? 'pass' : 'fail',
    detail: outcome.detail,
    durationMs: Date.now() - startedAt,
    ranAt: new Date().toISOString(),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(outcome.blocked === undefined ? {} : { blocked: outcome.blocked }),
    ...(hint === undefined ? {} : { hint }),
    ...(outcome.control === undefined ? {} : { control: outcome.control }),
    ...(load === undefined ? {} : { load }),
  };
}

/** Deploys the components, builds, and runs `entries`, all in the held workspace. */
async function buildAndRun(
  project: Project,
  entries: readonly Declared[],
  context: Omit<RunContext, 'session'>,
  dir: string
): Promise<GateEntry[]> {
  const { workspace, waitMs, recorder, reuse } = context;
  const built = await timed(
    'build',
    undefined,
    async () => {
      await deployComponents(workspace, { waitMs });
      const result = await build(workspace, { ui: project.config.gate?.build !== 'full', waitMs });
      return { pass: true, detail: `${result.kind} build` };
    },
    recorder
  );
  const session = controlSession();
  const results = [built];
  let proven = false;
  const toRun = entries.filter((entry) => reuse?.has(entry.id) !== true);
  for (const entry of entries) {
    const artifacts = entry.id.replace(':', '-');
    const reused = reuse?.get(entry.id);
    if (reused !== undefined) {
      results.push(reused);
      continue;
    }
    if (built.status !== 'pass') {
      const detail = built.blocked === undefined ? 'the build failed' : 'the build could not run';
      results.push({ id: entry.id, status: 'skipped', detail, durationMs: 0 });
      continue;
    }
    // Whatever follows the controls uses the build, which must not hold a mutation.
    if (!entry.id.startsWith('control:')) {
      await settle(workspace, session, waitMs, results);
    } else if (!proven) {
      proven = true;
      await proveFirst(toRun, workspace, session, waitMs);
    }
    // An entry that runs again leaves nothing of an earlier run in its directory.
    await remove(join(dir, artifacts));
    await ensureDir(join(dir, artifacts));
    results.push(
      await timed(
        entry.id,
        artifacts,
        () => entry.run({ ...context, session }, join(dir, artifacts)),
        recorder
      )
    );
  }
  await settle(workspace, session, waitMs, results);
  return results;
}

/**
 * Runs the unmutated tests of the controls before the first mutation, so no
 * control needs the engine rebuilt between two mutations to get its baseline.
 * A failure here only means each control runs its own baseline.
 */
async function proveFirst(
  entries: readonly Declared[],
  workspace: Workspace,
  session: ControlSession,
  waitMs: number | undefined
): Promise<void> {
  const planners = entries.flatMap((entry) => (entry.plan === undefined ? [] : [entry.plan]));
  if (planners.length < 2) return;
  try {
    const plans = await Promise.all(planners.map((plan) => plan(workspace)));
    await proveBaselines(workspace, plans, session, waitMs === undefined ? {} : { waitMs });
  } catch (error: unknown) {
    verbose(`The tests of the controls were not run first: ${toError(error).message}`);
  }
}

/** Builds the restored engine the controls left owed, and says so on the last control when that build failed. */
async function settle(
  workspace: Workspace,
  session: ControlSession,
  waitMs: number | undefined,
  results: GateEntry[]
): Promise<void> {
  const settled = await settleControls(workspace, session, waitMs === undefined ? {} : { waitMs });
  const last = results.findLast((entry) => entry.id.startsWith('control:'));
  if (settled === 'failed' && last !== undefined) {
    last.detail = `${last.detail}; the build of the restored engine failed, so the workspace needs "fireforge build"`;
  }
}

function checkEntry(check: CheckReport): GateEntry {
  return {
    id: 'check',
    status: check.pass ? 'pass' : 'fail',
    detail: check.pass ? `${check.steps.length} step(s)` : `failed: ${check.failed.join(', ')}`,
    durationMs: check.durationMs,
    ranAt: new Date().toISOString(),
  };
}

/** The declared acceptances nobody has recorded for the tree. */
async function outstanding(project: Project, head: Head): Promise<string[]> {
  const declared = project.config.gate?.acceptance ?? [];
  if (declared.length === 0) return [];
  const recorded = await readAcceptances(head.repository, head.tree);
  return declared.map((entry) => entry.id).filter((id) => recorded[id] === undefined);
}

/** The controls owed a run, read against the tree when the checkout is clean. */
async function owedFor(project: Project): Promise<OwedControl[]> {
  try {
    const head = await cleanHead(project).catch(() => undefined);
    return await owedControls(project, head);
  } catch (error: unknown) {
    verbose(`The control record was not read: ${toError(error).message}`);
    return [];
  }
}

/** A subset of the declared entries on the working tree as it is: built, run, and nothing recorded. */
async function feedback(
  project: Project,
  entries: readonly Declared[],
  options: GateOptions
): Promise<GateReport> {
  const { dir, results } = await withFeedbackDir(project, options.waitMs, async (dir) => ({
    dir,
    results: await withWorkspace(
      project,
      { command: 'gate', waitMs: options.waitMs, workspace: options.workspace },
      (workspace) =>
        buildAndRun(
          project,
          entries,
          { workspace, waitMs: options.waitMs, source: 'feedback' },
          dir
        )
    ),
  }));
  return {
    outcome: 'feedback',
    basis: 'feedback',
    pass: results.every((entry) => entry.status === 'pass'),
    entries: results,
    pending: [],
    artifacts: dir,
    owed: await owedFor(project),
  };
}

/** The error of a gate whose checkout moved while it ran, which makes its result say nothing. */
async function requireUnmoved(project: Project, commit: string): Promise<void> {
  const now = await cleanHead(project).catch(() => undefined);
  if (now?.commit !== commit) {
    throw new FireForgeError(
      'gate-tree-moved',
      'The working tree or HEAD changed while the gate ran, so its result says nothing about the commit.',
      {
        exitCode: ExitCode.INCONCLUSIVE,
        hint: 'Run the gate again and leave the checkout alone.',
      }
    );
  }
}

/** The declared controls a commit's change makes run again, or undefined when it needs more than that. */
async function lightRun(
  project: Project,
  head: Head,
  verified: string
): Promise<{ declared: Declared[]; documentsOnly: boolean } | undefined> {
  const light = await lightChange(project, verified, head.commit);
  if (light === undefined) return undefined;
  // A person who accepted on the output of a control looks at it again: that takes the full run.
  const evidence = (project.config.gate?.acceptance ?? []).flatMap((entry) => entry.evidence ?? []);
  if (light.rerun.some((id) => evidence.includes(`control:${id}`))) return undefined;
  const wanted = new Set(light.rerun.map((id) => `control:${id}`));
  const declared = declaredEntries(project).filter((entry) => wanted.has(entry.id));
  return { declared, documentsOnly: light.documentsOnly };
}

/**
 * The entries of an earlier run of the commit that stand again: declared
 * entries that passed in it and whose output is still in the commit's
 * directory, marked as reused with when they originally ran.
 */
async function reusedEntries(
  project: Project,
  commit: string,
  found: Resumable,
  declared: readonly Declared[]
): Promise<Map<string, GateEntry>> {
  const wanted = new Set(declared.map((entry) => entry.id));
  const reused = new Map<string, GateEntry>();
  for (const entry of found.entries) {
    if (entry.status !== 'pass' || !wanted.has(entry.id)) continue;
    if (!(await hasArtifacts(project, commit, entry))) continue;
    reused.set(entry.id, { ...entry, reused: true, ranAt: entry.ranAt ?? found.at });
  }
  return reused;
}

/**
 * A hash of what the gate declares and of the files its entries read by
 * name: the control diffs and the console allow files. The tree does not
 * speak for a file git ignores, so a recorded pass stands, and a run is
 * resumed, only while these hold what they held.
 */
async function inputsHash(project: Project): Promise<string> {
  const gate = project.config.gate;
  const named = new Set([
    ...(gate?.controls ?? []).map((entry) => entry.diff),
    ...(gate?.runs ?? []).flatMap((entry) =>
      entry.consoleAllowFile === undefined ? [] : [entry.consoleAllowFile]
    ),
  ]);
  const files: Record<string, string | null> = {};
  for (const path of [...named].sort()) {
    const bytes = await readBytesIfExists(resolve(project.root, path)).catch(() => undefined);
    files[path] = bytes === undefined ? null : hash(bytes);
  }
  return declarationHash({ gate: gate ?? null, files });
}

/** What `--resume` makes of the recorded run: the entries that stand, and what to tell the report. */
async function planResume(
  project: Project,
  head: Head,
  options: GateOptions,
  plan: Omit<RunPlanned, 'reuse'>
): Promise<{ reuse: Map<string, GateEntry>; resume: GateReport['resume'] }> {
  const { entries, declaration, partial } = plan;
  const none = new Map<string, GateEntry>();
  if (options.resume !== true) return { reuse: none, resume: undefined };
  if (partial) {
    return {
      reuse: none,
      resume: { reused: [], why: 'this commit needs only part of the gate, which always runs' },
    };
  }
  const found = await readResumable(project, head.commit, head.tree, declaration);
  if ('why' in found) {
    info(`Not resuming: ${found.why}. Every entry runs.`);
    return { reuse: none, resume: { reused: [], why: found.why } };
  }
  const reuse = await reusedEntries(project, head.commit, found, entries);
  info(
    reuse.size === 0
      ? `Nothing passed in the ${found.how} run of ${found.at}; every entry runs.`
      : `Resuming the ${found.how} run of ${found.at}: ${reuse.size} entr${reuse.size === 1 ? 'y' : 'ies'} that passed in it ${reuse.size === 1 ? 'is' : 'are'} not run again; check, the build and the rest run.`
  );
  return { reuse, resume: { reused: [...reuse.keys()] } };
}

/** What {@link executeRun} runs. */
interface RunPlanned {
  entries: readonly Declared[];
  declaration: string;
  /** Entries of an earlier run that stand and are not run again. */
  reuse: ReadonlyMap<string, GateEntry>;
  /** Whether only part of the gate runs, so no result is recorded for the commit. */
  partial: boolean;
}

/** Leases a workspace and runs the check, the build and `entries`, recording each entry as it ends. */
async function executeRun(
  project: Project,
  head: Head,
  options: GateOptions,
  planned: RunPlanned
): Promise<Pick<GateReport, 'basis' | 'entries' | 'check' | 'artifacts'>> {
  const { commit, tree } = head;
  const { entries, declaration, reuse, partial } = planned;
  const dir = await prepareGateDir(project, commit, { keep: reuse.size > 0 });
  const opened = await openRunRecord(project, {
    commit,
    tree,
    declaration,
    full: !partial,
    order: ['check', 'build', ...entries.map((entry) => entry.id)],
    carried: [...reuse.values()],
  });
  // A killed run never reaches the check that the checkout did not move, so
  // a pass is recorded for a later `--resume` only on a checkout still at the commit.
  const recorder: RunRecorder = {
    begin: (id) => opened.begin(id),
    complete: async (entry) => {
      const stands =
        entry.status !== 'pass' ||
        (await cleanHead(project).catch(() => undefined))?.commit === commit;
      await opened.complete(stands ? entry : { ...entry, status: 'skipped' });
    },
    interrupted: (id, load) => opened.interrupted(id, load),
    close: () => opened.close(),
  };
  // The new record holds everything the old result did, so the old one can go.
  if (reuse.size > 0) await dropResult(project, commit);
  const ran = await withWorkspace(
    project,
    { command: 'gate', waitMs: options.waitMs, workspace: options.workspace },
    async (workspace) => {
      step('Gate: check');
      const { check, checked } = await checkInRun(project, workspace, options, recorder);
      const context = {
        workspace,
        waitMs: options.waitMs,
        source: 'gate' as const,
        head: { commit, tree },
        recorder,
        reuse,
      };
      return { check, checked, entries: await buildAndRun(project, entries, context, dir) };
    }
  );
  try {
    await requireUnmoved(project, commit);
  } catch (error: unknown) {
    // Entries that passed while the checkout moved prove nothing a later run may reuse.
    await recorder.close();
    throw error;
  }
  const all = [ran.checked, ...ran.entries];
  // What stands for a commit is a full run; a partial one proves the changed controls and no more.
  if (!partial) {
    await writeResult(project, {
      commit,
      tree,
      pass: all.every((e) => e.status === 'pass'),
      entries: all,
      declaration,
    });
  }
  await recorder.close();
  return { basis: partial ? 'controls' : 'run', entries: all, check: ran.check, artifacts: dir };
}

/** Runs the check in the held workspace and records its entry. */
async function checkInRun(
  project: Project,
  workspace: Workspace,
  options: GateOptions,
  recorder: RunRecorder
): Promise<{ check: CheckReport; checked: GateEntry }> {
  await recorder.begin('check');
  const startLoad = sampleLoad();
  let check: CheckReport;
  try {
    check = await runCheck(project, { held: workspace, waitMs: options.waitMs });
  } catch (error: unknown) {
    if (isInterrupt(error)) await noteInterrupt('check', startLoad, recorder);
    throw error;
  }
  const checked = checkEntry(check);
  if (checked.status !== 'pass') {
    const load = await attributeLoad(startLoad);
    if (load !== undefined) checked.load = load;
  }
  await recorder.complete(checked);
  return { check, checked };
}

/** Everything a gate decides for a clean commit, holding the commit's run slot. */
async function judge(
  project: Project,
  head: Head,
  declared: readonly Declared[],
  options: GateOptions
): Promise<GateReport> {
  const { repository, commit, tree } = head;
  const verified = await resolveRevision(repository, VERIFIED_REF, 'commit');
  const identity = { commit, tree };
  if (verified === commit) {
    const basis = 'already-verified';
    const owed = await owedFor(project);
    return { outcome: 'verified', basis, pass: true, ...identity, entries: [], pending: [], owed };
  }
  if (
    verified !== undefined &&
    options.allowRewrite !== true &&
    !(await isAncestor(repository, verified, commit))
  ) {
    throw new FireForgeError(
      'gate-not-fast-forward',
      `${VERIFIED_REF} is at ${verified}, which is not an ancestor of ${commit}.`,
      {
        exitCode: ExitCode.GIT_ERROR,
        hint: 'Gate a descendant of the verified commit, or pass --allow-rewrite to move the ref here anyway.',
      }
    );
  }

  let report: Pick<GateReport, 'basis' | 'entries' | 'check' | 'artifacts' | 'resume'>;
  let resume: GateReport['resume'];
  const declaration = await inputsHash(project);
  const found = await readResult(project, commit, tree);
  // A pass stands only for the gate as declared, with the files it reads as they were.
  const recorded =
    found?.pass === true && (found.declaration === undefined || found.declaration === declaration)
      ? found
      : undefined;
  const light =
    recorded === undefined && verified !== undefined
      ? await lightRun(project, head, verified)
      : undefined;
  if (recorded !== undefined) {
    info(`This commit passed the gate at ${recorded.finishedAt}; that result stands.`);
    report = { basis: 'recorded', entries: recorded.entries, artifacts: gateDir(project, commit) };
  } else if (light !== undefined && light.declared.length === 0) {
    info(
      light.documentsOnly
        ? 'Only documents changed since the verified commit; the check alone decides.'
        : 'Only documents, control diffs and gate.controls changed since the verified commit, and no control changed; the check alone decides.'
    );
    const check = await runCheck(project, { waitMs: options.waitMs, workspace: options.workspace });
    await requireUnmoved(project, commit);
    report = {
      basis: light.documentsOnly ? 'documents' : 'controls',
      entries: [checkEntry(check)],
      check,
    };
  } else {
    const entries = light === undefined ? declared : light.declared;
    if (light !== undefined) {
      info(
        `Only documents, control diffs and gate.controls changed since the verified commit; the check, the build and ${light.declared.length} control(s) decide.`
      );
    }
    const planned = await planResume(project, head, options, {
      entries,
      declaration,
      partial: light !== undefined,
    });
    resume = planned.resume;
    report = await executeRun(project, head, options, {
      entries,
      declaration,
      reuse: planned.reuse,
      partial: light !== undefined,
    });
  }

  const owed = await owedFor(project);
  const pass = report.entries.every((entry) => entry.status === 'pass');
  if (resume !== undefined) report = { ...report, resume };
  if (!pass) return { outcome: 'failed', pass, ...identity, pending: [], owed, ...report };
  // A commit whose product code is the verified commit's shows a person nothing the verified commit did not.
  const pending =
    report.basis === 'documents' || report.basis === 'controls'
      ? []
      : await outstanding(project, head);
  if (pending.length > 0)
    return { outcome: 'pending', pass, ...identity, pending, owed, ...report };
  if (!(await updateRef(repository, VERIFIED_REF, commit, { expect: verified ?? null }))) {
    throw new FireForgeError(
      'gate-ref-moved',
      `${VERIFIED_REF} moved while the gate ran; it was left where the other gate put it.`,
      { exitCode: ExitCode.GIT_ERROR, hint: 'Run "fireforge gate" again.' }
    );
  }
  return { outcome: 'verified', pass, ...identity, pending, owed, ...report };
}

/**
 * Runs the gate on the checked-out commit and moves the verified ref when it
 * passed with every acceptance recorded.
 *
 * @param project - The project
 * @param options - See {@link GateOptions}
 * @returns The report; a red gate is a result, not an exception
 * @throws `gate-no-commit` (exit code 4) and `gate-dirty-tree` (exit code 1)
 *   before anything runs; `gate-not-fast-forward` (exit code 4) when the
 *   verified commit is not an ancestor and `allowRewrite` is off;
 *   `gate-tree-moved` (exit code 14) when the working tree or HEAD changed
 *   while the gate ran; `gate-ref-moved` (exit code 4) when another gate
 *   moved the ref meanwhile; `lock-timeout` (exit code 15), also when another
 *   gate on the same commit did not finish in time
 */
export async function runGate(project: Project, options: GateOptions = {}): Promise<GateReport> {
  const declared = declaredEntries(project);
  if (options.only !== undefined && options.only.length > 0) {
    return feedback(project, selectEntries(declared, options.only), options);
  }
  const head = await cleanHead(project);
  return withGateRun(project, head.commit, options.waitMs, () =>
    judge(project, head, declared, options)
  );
}

/**
 * The error a command ends with for a report that did not pass: exit code 5
 * when the build or a declared entry is red, as a failed build or test run
 * has, and exit code 1 when only the check is, as `check` has. A report whose
 * every red entry is blocked, because a lock did not come free or the engine
 * changed under it, says nothing about the commit: it ends with the code of
 * that failure (exit code 15 or 14), as the commands that ran the work alone
 * do.
 *
 * @param report - The report
 * @returns Undefined for a report that passed
 */
export function gateFailure(report: GateReport): FireForgeError | undefined {
  if (report.pass) return undefined;
  const failed = report.entries.filter((entry) => entry.status === 'fail');
  const red = failed.filter((entry) => entry.blocked === undefined).map((entry) => entry.id);
  const blocked = failed.filter((entry) => entry.blocked !== undefined);
  const first = blocked[0];
  if (red.length === 0 && first !== undefined) {
    const inconclusive = first.blocked === 'inconclusive';
    return new FireForgeError(
      inconclusive ? 'gate-inconclusive' : 'lock-timeout',
      `The gate could not judge the commit: ${blocked.map((entry) => `${entry.id} (${entry.detail})`).join('; ')}.`,
      {
        exitCode: inconclusive ? ExitCode.INCONCLUSIVE : ExitCode.LOCK_TIMEOUT,
        hint:
          first.hint ??
          (inconclusive
            ? 'Run the gate again and leave the engine alone while it runs.'
            : 'Run the gate again, or pass --wait-lock <seconds> to wait longer.'),
      }
    );
  }
  const onlyCheck = red.every((id) => id === 'check');
  return new FireForgeError(
    onlyCheck ? 'gate-check-failed' : 'gate-failed',
    `The gate did not pass: ${red.join(', ')}.`,
    {
      exitCode: onlyCheck ? ExitCode.GENERAL_ERROR : ExitCode.BUILD_ERROR,
      hint: 'Fix what each red entry reports above, commit, and run the gate again; "fireforge gate --lane <id>" runs one entry.',
    }
  );
}

/**
 * The lines that say which declared controls are owed a run and why.
 *
 * @param owed - From the report or the status
 */
export function renderOwed(owed: readonly OwedControl[]): string[] {
  if (owed.length === 0) return [];
  return [
    `Controls owed a run (${owed.length}):`,
    ...owed.map((entry) => `  control:${entry.id}  ${entry.reason}: ${entry.detail}`),
    'Run them with: fireforge gate --lane "control:*"',
  ];
}

/**
 * The report's entries for a person, with what happens next.
 *
 * @param report - The report
 */
export function renderGate(report: GateReport): string[] {
  const width = Math.max(...report.entries.map((entry) => entry.id.length), 5);
  const lines = report.entries.map((entry) => {
    const time = entry.status === 'skipped' ? '' : formatDuration(entry.durationMs);
    const status = entry.blocked === undefined ? entry.status : 'blocked';
    const notes = [
      ...(entry.reused === true ? [`reused: it ran ${entry.ranAt ?? 'in an earlier run'}`] : []),
      ...(entry.load === undefined ? [] : [renderLoad(entry.load)]),
    ];
    const detail = notes.length === 0 ? entry.detail : `${entry.detail} [${notes.join('; ')}]`;
    return `${entry.id.padEnd(width)}  ${status.padEnd(7)}  ${time.padStart(6)}  ${detail}`.trimEnd();
  });
  for (const entry of report.entries) {
    if (entry.blocked !== undefined && entry.hint !== undefined) {
      lines.push(`${entry.id}: ${entry.hint}`);
    }
  }
  const reused = report.entries.filter((entry) => entry.reused === true);
  if (reused.length > 0) {
    lines.push(
      `${reused.length} entr${reused.length === 1 ? 'y' : 'ies'} reused from an earlier run of this commit, not run again: ${reused.map((entry) => entry.id).join(', ')}.`
    );
  } else if (report.resume?.why !== undefined) {
    lines.push(`Not resumed: ${report.resume.why}; every entry ran.`);
  }
  if (report.artifacts !== undefined) lines.push(`Logs and outputs: ${report.artifacts}`);
  const short = report.commit?.slice(0, 12) ?? '';
  if (report.outcome === 'verified') {
    lines.push(
      report.basis === 'already-verified'
        ? `${VERIFIED_REF} is already at ${short}.`
        : `Gate passed: ${VERIFIED_REF} is now at ${short}.`
    );
  } else if (report.outcome === 'pending') {
    lines.push(`Gate passed for ${short}. It is verified once a person has recorded:`);
    for (const id of report.pending)
      lines.push(`  fireforge gate accept ${id} --note "<what you saw>"`);
    lines.push('Then run "fireforge gate" again; the recorded pass stands and nothing is re-run.');
  } else if (report.outcome === 'feedback') {
    lines.push(
      `${report.pass ? 'Passed' : 'Failed'}. A subset ran on the working tree; nothing was recorded.`
    );
  } else if (report.entries.some((entry) => entry.blocked !== undefined)) {
    lines.push(`Gate could not judge ${short}; ${VERIFIED_REF} stays where it was.`);
  } else {
    lines.push(`Gate failed for ${short}; ${VERIFIED_REF} stays where it was.`);
  }
  lines.push(...renderOwed(report.owed));
  return lines;
}

/** What `gate accept` recorded. */
export interface AcceptResult {
  id: string;
  commit: string;
  tree: string;
  acceptance: Acceptance;
  /** Acceptances the tree still needs. */
  pending: string[];
}

/**
 * Records a person's decision for the checked-out commit's tree.
 *
 * @param project - The project
 * @param id - A declared acceptance
 * @param decision - The note, and who decides when not the repository's `user.name` or the login name
 * @throws `invalid-argument` for an undeclared ID, `gate-dirty-tree`,
 *   `gate-evidence-missing` (exit code 1) when a lane the acceptance stands
 *   on has no recorded pass for this tree in this checkout
 */
export async function acceptGate(
  project: Project,
  id: string,
  decision: { note: string; by?: string | undefined }
): Promise<AcceptResult> {
  const declared = project.config.gate?.acceptance ?? [];
  const entry = declared.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw usageError(
      `The gate declares no acceptance "${id}"`,
      declared.length === 0
        ? 'fireforge.json declares none under "gate.acceptance".'
        : `Declared: ${declared.map((candidate) => candidate.id).join(', ')}.`
    );
  }
  const head = await cleanHead(project);
  const evidence = entry.evidence ?? [];
  if (evidence.length > 0) {
    const result = await readResult(project, head.commit, head.tree);
    const missing = evidence.filter(
      (name) => result?.entries.find((ran) => ran.id === name)?.status !== 'pass'
    );
    if (missing.length > 0) {
      throw new FireForgeError(
        'gate-evidence-missing',
        `"${id}" stands on ${missing.join(', ')}, which ${missing.length === 1 ? 'has' : 'have'} no recorded pass for this commit in this checkout.`,
        { hint: 'Run "fireforge gate" here first, look at what it produced, then accept.' }
      );
    }
  }
  const acceptance = {
    by: decision.by ?? (await getConfig(head.repository, 'user.name')) ?? userInfo().username,
    at: new Date().toISOString(),
    note: decision.note,
    commit: head.commit,
  };
  await recordAcceptance(head.repository, head.tree, id, acceptance);
  return {
    id,
    commit: head.commit,
    tree: head.tree,
    acceptance,
    pending: await outstanding(project, head),
  };
}

/** Where the verified ref is and what is known about HEAD. */
export interface GateStatus {
  head: string;
  /** Whether the working tree equals HEAD. */
  clean: boolean;
  /** The verified commit, or undefined when no gate has passed yet. */
  verified?: string;
  /** How HEAD relates to the verified commit. */
  relation: 'verified' | 'ahead' | 'diverged' | 'unverified';
  /** Commits on HEAD since the verified one, when HEAD descends from it. */
  ahead?: number;
  /** The recorded result of HEAD in this checkout, when it still stands. */
  result?: { pass: boolean; finishedAt: string; entries: GateEntry[] };
  /** Recorded and outstanding acceptances of HEAD's tree. */
  accepted: Record<string, Acceptance>;
  pending: string[];
  /** Declared controls with no standing proof in this checkout, each with why. */
  controls: OwedControl[];
  /** Gates running in this checkout right now; `onHead` marks the one judging HEAD. */
  running: (RunningGate & { onHead: boolean })[];
}

/**
 * Reads where the verified ref is relative to HEAD and what the last gate on
 * HEAD recorded, changing nothing.
 *
 * @param project - The project
 * @throws `gate-no-commit` (exit code 4)
 */
export async function gateStatus(project: Project): Promise<GateStatus> {
  const checkedOut = await headCommit(project);
  const { repository, commit: head, tree } = checkedOut;
  const verified = await resolveRevision(repository, VERIFIED_REF, 'commit');
  const descends = verified !== undefined && (await isAncestor(repository, verified, head));
  const result = await readResult(project, head, tree);
  const clean = (await status(repository)).length === 0;
  return {
    head,
    clean,
    ...(verified === undefined ? {} : { verified }),
    relation:
      verified === undefined
        ? 'unverified'
        : verified === head
          ? 'verified'
          : descends
            ? 'ahead'
            : 'diverged',
    ...(descends && verified !== head
      ? {
          ahead: Number(
            (await git(['rev-list', '--count', `${verified}..${head}`], { cwd: repository })).trim()
          ),
        }
      : {}),
    ...(result === undefined
      ? {}
      : {
          result: { pass: result.pass, finishedAt: result.finishedAt, entries: result.entries },
        }),
    accepted: await readAcceptances(repository, tree),
    pending: await outstanding(project, checkedOut),
    controls: await owedControls(project, clean ? { tree } : undefined).catch(() => []),
    running: (await readRunningGates(project).catch(() => [])).map((gate) => ({
      ...gate,
      onHead: gate.commit === head,
    })),
  };
}
