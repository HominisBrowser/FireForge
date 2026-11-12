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
 * alone.
 */
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { usageError } from '../cli/command.js';
import { ARTIFACTS_PLACEHOLDER, type GateConfig, type GateLane } from '../config/index.js';
import { build, runBrowser, type Workspace } from '../engine/index.js';
import {
  changedPaths,
  getConfig,
  git,
  isAncestor,
  resolveRevision,
  status,
  updateRef,
} from '../git/index.js';
import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { ensureDir, remove } from '../kernel/fs.js';
import { matchesAnyGlob } from '../kernel/glob.js';
import { info, step } from '../kernel/log.js';
import { run } from '../kernel/process/index.js';
import { formatDuration } from '../kernel/time.js';
import { deployComponents, mutationRoots, withWorkspace } from '../mode/index.js';
import type { Project } from '../project/index.js';
import {
  controlReport,
  planTests,
  runControl,
  runReport,
  runTests,
  validatorEnvironment,
  writeResults,
} from '../test/index.js';
import { type CheckReport, runCheck } from './check.js';
import {
  type Acceptance,
  gateDir,
  type GateEntry,
  prepareGateDir,
  readAcceptances,
  readResult,
  recordAcceptance,
  VERIFIED_REF,
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
   * commit, the check alone for a documents-only commit, or nothing because
   * the ref was already there.
   */
  basis: 'run' | 'recorded' | 'documents' | 'already-verified' | 'feedback';
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
}

/** A declared lane, stress run, control or smoke start, ready to run. */
interface Declared {
  /** `kind:id`. */
  id: string;
  /** Runs it with `artifacts` as its private output directory. A thrown error is a red. */
  run: (context: RunContext, artifacts: string) => Promise<{ pass: boolean; detail: string }>;
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
    };
  };
}

function control(
  project: Project,
  declared: NonNullable<GateConfig['controls']>[number]
): Declared['run'] {
  return async ({ workspace, waitMs }, artifacts) => {
    const plan = await planTests(workspace.engineDir, { paths: [declared.test] });
    const result = await runControl(
      workspace,
      plan,
      {
        diff: join(project.root, declared.diff),
        expect: declared.assertions,
        roots: await mutationRoots(project),
      },
      waitMs === undefined ? {} : { waitMs }
    );
    await writeResults(join(artifacts, 'results.json'), controlReport(result).document);
    return {
      pass: result.outcome === 'caught',
      detail: result.why === undefined ? result.outcome : `${result.outcome}: ${result.why}`,
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
    })),
    ...(gate?.runs ?? []).map((entry) => ({ id: `run:${entry.id}`, run: smoke(project, entry) })),
  ];
}

/** The declared entries an invocation named, by `kind:id` or by a bare ID. */
function selectEntries(all: readonly Declared[], names: readonly string[]): Declared[] {
  for (const name of names) {
    if (!all.some((entry) => entry.id === name || entry.id.endsWith(`:${name}`))) {
      throw usageError(
        `The gate declares no "${name}"`,
        all.length === 0
          ? 'fireforge.json declares no lanes, stress runs, controls or runs under "gate".'
          : `Declared: ${all.map((entry) => entry.id).join(', ')}.`
      );
    }
  }
  return all.filter((entry) =>
    names.some((name) => entry.id === name || entry.id.endsWith(`:${name}`))
  );
}

async function timed(
  id: string,
  artifacts: string | undefined,
  body: () => Promise<{ pass: boolean; detail: string }>
): Promise<GateEntry> {
  const startedAt = Date.now();
  step(`Gate: ${id}`);
  const outcome = await body().catch((error: unknown) => ({
    pass: false,
    detail: toError(error).message.split('\n')[0] ?? '',
  }));
  return {
    id,
    status: outcome.pass ? 'pass' : 'fail',
    detail: outcome.detail,
    durationMs: Date.now() - startedAt,
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

/** Deploys the components, builds, and runs `entries`, all in the held workspace. */
async function buildAndRun(
  project: Project,
  entries: readonly Declared[],
  context: RunContext,
  dir: string
): Promise<GateEntry[]> {
  const { workspace, waitMs } = context;
  const built = await timed('build', undefined, async () => {
    await deployComponents(workspace, { waitMs });
    const result = await build(workspace, { ui: project.config.gate?.build !== 'full', waitMs });
    return { pass: true, detail: `${result.kind} build` };
  });
  const results = [built];
  for (const entry of entries) {
    const artifacts = entry.id.replace(':', '-');
    if (built.status !== 'pass') {
      results.push({ id: entry.id, status: 'skipped', detail: 'the build failed', durationMs: 0 });
      continue;
    }
    await ensureDir(join(dir, artifacts));
    results.push(await timed(entry.id, artifacts, () => entry.run(context, join(dir, artifacts))));
  }
  return results;
}

function checkEntry(check: CheckReport): GateEntry {
  return {
    id: 'check',
    status: check.pass ? 'pass' : 'fail',
    detail: check.pass ? `${check.steps.length} step(s)` : `failed: ${check.failed.join(', ')}`,
    durationMs: check.durationMs,
  };
}

/**
 * Whether the commit differs from the verified one in nothing the gate
 * tests: the same tree, or only paths `gate.documents` covers.
 */
async function documentsOnly(project: Project, head: Head, verified: string): Promise<boolean> {
  const changed = await changedPaths(head.repository, verified, head.commit);
  const globs = project.config.gate?.documents ?? [];
  return changed.every((path) => matchesAnyGlob(path, globs, { basename: true }));
}

/** The declared acceptances nobody has recorded for the tree. */
async function outstanding(project: Project, head: Head): Promise<string[]> {
  const declared = project.config.gate?.acceptance ?? [];
  if (declared.length === 0) return [];
  const recorded = await readAcceptances(head.repository, head.tree);
  return declared.map((entry) => entry.id).filter((id) => recorded[id] === undefined);
}

/** A subset of the declared entries on the working tree as it is: built, run, and nothing recorded. */
async function feedback(
  project: Project,
  entries: readonly Declared[],
  options: GateOptions
): Promise<GateReport> {
  const dir = join(project.paths.stateDir, 'gate', 'feedback');
  await remove(dir);
  const results = await withWorkspace(
    project,
    { command: 'gate', waitMs: options.waitMs, workspace: options.workspace },
    (workspace) => buildAndRun(project, entries, { workspace, waitMs: options.waitMs }, dir)
  );
  return {
    outcome: 'feedback',
    basis: 'feedback',
    pass: results.every((entry) => entry.status === 'pass'),
    entries: results,
    pending: [],
    artifacts: dir,
  };
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
 *   moved the ref meanwhile; `lock-timeout` (exit code 15)
 */
export async function runGate(project: Project, options: GateOptions = {}): Promise<GateReport> {
  const declared = declaredEntries(project);
  if (options.only !== undefined && options.only.length > 0) {
    return feedback(project, selectEntries(declared, options.only), options);
  }
  const head = await cleanHead(project);
  const { repository, commit, tree } = head;
  const verified = await resolveRevision(repository, VERIFIED_REF, 'commit');
  const identity = { commit, tree };
  if (verified === commit) {
    const basis = 'already-verified';
    return { outcome: 'verified', basis, pass: true, ...identity, entries: [], pending: [] };
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

  let report: Pick<GateReport, 'basis' | 'entries' | 'check' | 'artifacts'>;
  const recorded = await readResult(project, commit, tree);
  if (recorded?.pass === true) {
    info(`This commit passed the gate at ${recorded.finishedAt}; that result stands.`);
    report = { basis: 'recorded', entries: recorded.entries, artifacts: gateDir(project, commit) };
  } else if (verified !== undefined && (await documentsOnly(project, head, verified))) {
    info('Only documents changed since the verified commit; the check alone decides.');
    const check = await runCheck(project, { waitMs: options.waitMs, workspace: options.workspace });
    report = { basis: 'documents', entries: [checkEntry(check)], check };
  } else {
    const dir = await prepareGateDir(project, commit);
    const ran = await withWorkspace(
      project,
      { command: 'gate', waitMs: options.waitMs, workspace: options.workspace },
      async (workspace) => {
        step('Gate: check');
        const check = await runCheck(project, { held: workspace, waitMs: options.waitMs });
        const context = { workspace, waitMs: options.waitMs };
        return { check, entries: await buildAndRun(project, declared, context, dir) };
      }
    );
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
    const entries = [checkEntry(ran.check), ...ran.entries];
    const pass = entries.every((entry) => entry.status === 'pass');
    await writeResult(project, { commit, tree, pass, entries });
    report = { basis: 'run', entries, check: ran.check, artifacts: dir };
  }

  const pass = report.entries.every((entry) => entry.status === 'pass');
  if (!pass) return { outcome: 'failed', pass, ...identity, pending: [], ...report };
  // A documents-only commit shows a person nothing the verified commit did not.
  const pending = report.basis === 'documents' ? [] : await outstanding(project, head);
  if (pending.length > 0) return { outcome: 'pending', pass, ...identity, pending, ...report };
  if (!(await updateRef(repository, VERIFIED_REF, commit, { expect: verified ?? null }))) {
    throw new FireForgeError(
      'gate-ref-moved',
      `${VERIFIED_REF} moved while the gate ran; it was left where the other gate put it.`,
      { exitCode: ExitCode.GIT_ERROR, hint: 'Run "fireforge gate" again.' }
    );
  }
  return { outcome: 'verified', pass, ...identity, pending, ...report };
}

/**
 * The error a command ends with for a report that did not pass: exit code 5
 * when the build or a declared entry is red, as a failed build or test run
 * has, and exit code 1 when only the check is, as `check` has.
 *
 * @param report - The report
 * @returns Undefined for a report that passed
 */
export function gateFailure(report: GateReport): FireForgeError | undefined {
  if (report.pass) return undefined;
  const red = report.entries.filter((entry) => entry.status === 'fail').map((entry) => entry.id);
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
 * The report's entries for a person, with what happens next.
 *
 * @param report - The report
 */
export function renderGate(report: GateReport): string[] {
  const width = Math.max(...report.entries.map((entry) => entry.id.length), 5);
  const lines = report.entries.map((entry) => {
    const time = entry.status === 'skipped' ? '' : formatDuration(entry.durationMs);
    return `${entry.id.padEnd(width)}  ${entry.status.padEnd(7)}  ${time.padStart(6)}  ${entry.detail}`.trimEnd();
  });
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
  } else {
    lines.push(`Gate failed for ${short}; ${VERIFIED_REF} stays where it was.`);
  }
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
  return {
    head,
    clean: (await status(repository)).length === 0,
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
  };
}
