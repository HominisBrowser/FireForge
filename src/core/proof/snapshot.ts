// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../../errors/base.js';
import type { ProofConfig } from '../../types/config.js';
import { escapeRegex } from '../../utils/regex.js';
import { canonicalJson, readSourceBlobs, sourceGit, sourceGitStatus } from '../authored/git.js';
import { assertSourcePath } from '../authored/paths.js';
import { parseDeclaration, snapshotIdentityOfTree } from '../authored/provider.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { deployedComponentPath } from '../furnace-composed-source.js';
import { validateFurnaceConfig } from '../furnace-config.js';
import { adapterOptionValues } from '../jobs/adapter-arguments.js';
import { fullCheckContractForSnapshot } from '../jobs/check-contract.js';
import { buildRecipeDigest } from '../jobs/runtime-state.js';
import { compiledSourceDigest } from '../jobs/source-build.js';
import { validatorScript } from '../jobs/step-validate.js';
import { isTestManifestPath } from '../test-manifest-support.js';
import { answeredDeclaration, judgeChangesBetween, readDeclaration } from './declaration.js';
import { createProofPlan, type TaskControl } from './plan.js';
import { typecheckInput } from './plan-typecheck.js';
import { isTestPath, rootRoute, runtimeRoute } from './route.js';
import type { ChangedPath, PlanBase, PlanCarry, ProofPlan, ProofTier } from './types.js';
import {
  isAncestor,
  lastCleanVerified,
  readCarryRecord,
  readVerified,
  readWaiverRecord,
  resolveCommit,
  VERIFIED_REF,
} from './verified.js';

const text = (bytes: Buffer): string => bytes.toString('utf8').trim();

export interface MainBranch {
  /** The branches to look for, in order. */
  names: string[];
  /** Named only by the candidate, with nothing older to check it against. */
  selfDeclared: boolean;
}

/**
 * The main branch, from history rather than from the candidate: a candidate naming
 * its own branch would compare with itself. The last verified commit says, then the
 * tip of `main` or `master`. A candidate's own statement counts only when there is
 * neither, and takes effect for everything else once it has landed.
 */
export async function mainBranch(
  root: string,
  candidate: ProofConfig | undefined
): Promise<MainBranch> {
  const verified = await readVerified(root);
  const tips = (
    await Promise.all(
      ['main', 'master'].map(async (name) => ({
        name,
        tip: await resolveCommit(root, `refs/heads/${name}`),
      }))
    )
  ).filter(({ tip }) => tip !== undefined);
  for (const commit of [verified, ...tips.map(({ tip }) => tip)]) {
    if (commit === undefined) continue;
    const named = (await readDeclaration(root, commit)).proof?.mainBranch;
    if (named !== undefined) return { names: [named], selfDeclared: false };
  }
  if (tips.length > 0) return { names: tips.map(({ name }) => name), selfDeclared: false };
  return candidate?.mainBranch === undefined
    ? { names: [], selfDeclared: false }
    : { names: [candidate.mainBranch], selfDeclared: true };
}

interface DefaultBase {
  commit: string;
  label: string;
  selfDeclared: boolean;
  /** The last commit published clean, whose gate evidence a documents-only change can carry. */
  verified?: true;
  /** Why this is not the verified commit. */
  note?: string;
}

/** The base a tier compares against when none is named. */
async function defaultBase(
  root: string,
  candidate: ProofConfig | undefined,
  tier: ProofTier,
  head: string
): Promise<DefaultBase | undefined> {
  let note: string | undefined;
  if (tier === 'gate') {
    const verified = await readVerified(root);
    const clean = await lastCleanVerified(root);
    if (verified !== undefined && clean !== verified)
      note = `${VERIFIED_REF} at ${verified.slice(0, 12)} was published with waived obligations, so this gate compares with the last clean commit.`;
    if (clean !== undefined && (await isAncestor(root, clean, head)))
      return {
        commit: clean,
        label: clean === verified ? VERIFIED_REF : `last clean ${VERIFIED_REF}`,
        selfDeclared: false,
        verified: true,
        ...(note === undefined ? {} : { note }),
      };
  }
  const { names, selfDeclared } = await mainBranch(root, candidate);
  for (const branch of names) {
    const tip = await resolveCommit(root, `refs/heads/${branch}`);
    if (tip === undefined) continue;
    const { code, stdout } = await sourceGitStatus(root, ['merge-base', tip, head]);
    if (code === 0)
      return {
        commit: text(stdout),
        label: `merge-base with ${branch}`,
        selfDeclared,
        ...(note === undefined ? {} : { note }),
      };
  }
  return undefined;
}

/**
 * Resolves what a candidate is compared against, once. A named base that leaves
 * out commits the default would cover is usable for feedback and recorded as
 * narrowed, which is what stops it claiming completion.
 *
 * @param root - The checkout, not the object store: `HEAD` means this worktree's
 * @param head - The commit the candidate descends from; defaults to this checkout's
 */
async function resolveBase(
  root: string,
  options: { proof?: ProofConfig; tier: ProofTier; named?: string; head?: string }
): Promise<{ base: PlanBase; fallback: DefaultBase | undefined }> {
  const head = options.head ?? (await resolveCommit(root, 'HEAD'));
  if (head === undefined) throw new GeneralError('proof-base-required: this checkout has no HEAD');
  const fallback = await defaultBase(root, options.proof, options.tier, head);
  const named = options.named === undefined ? undefined : await resolveCommit(root, options.named);
  if (options.named !== undefined && named === undefined)
    throw new GeneralError(`proof-base-unknown: ${options.named} names no commit`);
  const commit = named ?? fallback?.commit;
  if (commit === undefined)
    throw new GeneralError(
      'proof-base-required: no main branch to compare with. Name one with --base, or set proof.mainBranch.'
    );
  const tree = text(await sourceGit(root, ['rev-parse', '--verify', `${commit}^{tree}`]));
  return {
    fallback,
    base: {
      commit,
      tree,
      label: named === undefined ? (fallback?.label ?? '') : `--base ${options.named ?? ''}`,
      narrowed:
        named !== undefined &&
        (fallback === undefined || !(await isAncestor(root, named, fallback.commit))),
    },
  };
}

/**
 * An upstream record as planning reads it: everything but where its base sits in
 * upstream history, which a pin refresh moves without changing what materializes.
 * Unreadable is never the same as anything.
 */
async function recordIdentity(
  root: string,
  tree: string,
  path: string
): Promise<string | undefined> {
  const { code, stdout } = await sourceGitStatus(root, ['cat-file', 'blob', `${tree}:${path}`]);
  if (code !== 0) return undefined;
  try {
    const { base, ...declaration } = parseDeclaration(JSON.parse(stdout.toString('utf8')));
    return canonicalJson({ ...declaration, mode: base.mode });
  } catch {
    return undefined;
  }
}

/** Every path differing from the base, in the terms a route reads: engine or project root. */
async function changedPaths(
  root: string,
  snapshot: AuthoredSnapshot,
  baseTree: string
): Promise<ChangedPath[]> {
  const sources = snapshot.config.sources;
  if (sources === undefined) throw new GeneralError('proof-authored-mode-required');
  const raw = await sourceGit(root, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    baseTree,
    snapshot.tree,
  ]);
  const present = new Map(snapshot.files.map((file) => [file.path, file]));
  const inputs = new Set(snapshot.inputs.map((input) => input.path));
  const overrides = `${sources.metadataRoot}/overrides/`;
  const changes = new Map<string, ChangedPath>();
  const paths = raw.toString('utf8').split('\0').filter(Boolean);
  const sourcePaths = new Set(paths.filter((path) => path.startsWith(`${sources.root}/`)));
  for (const path of paths) {
    const engine = path.startsWith(`${sources.root}/`)
      ? path.slice(sources.root.length + 1)
      : path.startsWith(overrides)
        ? path.slice(overrides.length).replace(/\.json$/, '')
        : undefined;
    if (
      engine !== undefined &&
      path.startsWith(overrides) &&
      !sourcePaths.has(`${sources.root}/${engine}`)
    ) {
      // Same postimage, and a record that only rebased with the pin: the path did not change.
      const before = await recordIdentity(root, baseTree, path);
      if (before !== undefined && before === (await recordIdentity(root, snapshot.tree, path)))
        continue;
    }
    if (engine !== undefined) {
      const file = present.get(engine);
      changes.set(engine, {
        path: engine,
        tree: 'engine',
        route: runtimeRoute(engine),
        deleted: file === undefined || file.kind === 'delete',
      });
    } else
      changes.set(path, {
        path,
        tree: 'root',
        route: path.startsWith(`${sources.metadataRoot}/`) ? 'none' : rootRoute(path),
        deleted: !inputs.has(path),
      });
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The engine paths a diff mutates, as Git or `diff -u` names them. */
function diffTargets(diff: string): string[] {
  const targets = new Set<string>();
  for (const match of diff.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)) {
    const path = match[1]?.replace(/^engine\//, '');
    if (path !== undefined && path !== '/dev/null') targets.add(path);
  }
  return [...targets];
}

/** Files a project's declaration runs against, which a capture has to hold beside its source. */
export function declaredInputs(proof: ProofConfig | undefined): string[] {
  const gate = proof?.gate;
  const scripts = [...(gate?.lanes ?? []), ...(gate?.stress ?? []), ...(gate?.runs ?? [])].flatMap(
    (lane) => {
      const script = lane.validate === undefined ? undefined : validatorScript(lane.validate);
      return script === undefined ? [] : [script];
    }
  );
  const fileOptions = (command: string, args: string[]): string[] => [
    ...adapterOptionValues({ command, args }, '--console-allow-file'),
    ...adapterOptionValues({ command, args }, '--profile-file').map(
      (value) => value.split('=')[0] ?? ''
    ),
  ];
  return [
    ...scripts,
    ...(gate?.controls ?? []).map((control) => control.diff),
    ...(gate?.runs ?? []).flatMap((run) => fileOptions('run', run.args)),
    ...[...(gate?.lanes ?? []), ...(gate?.stress ?? [])].flatMap((lane) =>
      fileOptions('test', lane.args ?? [])
    ),
  ];
}

/**
 * Root files that decide how a declared validator's Node reads its script, which a
 * none route leaves out of a build but not out of a lane.
 */
const NODE_PACKAGE_FILES = ['package.json', 'package-lock.json'];

/**
 * Whether every change is a document no build, test or judge reads: a none-route
 * path at the project root, outside the source metadata and every declared input.
 * Engine paths never are, since a test can declare one as a support file.
 */
const onlyDocuments = (
  changed: readonly ChangedPath[],
  excluded: ReadonlySet<string>,
  metadataRoot: string
): boolean =>
  changed.length > 0 &&
  changed.every(
    (change) =>
      change.tree === 'root' &&
      change.route === 'none' &&
      !excluded.has(change.path) &&
      !change.path.startsWith(`${metadataRoot}/`)
  );

/** The furthest a carry looks back along first parents for a commit whose gate is complete. */
const MAX_CARRY_WALK = 50;

/**
 * Whether a commit's tree, as this source under the candidate's pin, has complete
 * gate evidence of its own: every obligation met under the present tools, nothing
 * waived, and nothing itself carried.
 */
export type CleanGateProbe = (commit: string, tree: string, source: string) => Promise<boolean>;

interface CarryQuestion {
  root: string;
  request: Pick<PlanRequest, 'tier' | 'base' | 'cleanGate'>;
  snapshot: AuthoredSnapshot;
  /** The commit the candidate descends from. */
  head: string;
  base: PlanBase;
  fallback: DefaultBase | undefined;
  /** What decides the gate and differs from the base. */
  changes: readonly string[];
  /** Whether the candidate is documents-only since this tree. */
  documentsSince: (tree: string) => Promise<boolean>;
}

/**
 * The verified commit whose gate evidence a documents-only candidate carries: only
 * from the default gate base, published clean. A commit published on carried
 * evidence carries from where that evidence is, so a chain of documents commits
 * never asks a source with no runs of its own; the candidate has to be
 * documents-only from there too, and judged alike.
 */
async function verifiedOrigin(question: CarryQuestion): Promise<PlanCarry | undefined> {
  const { root, snapshot, base, documentsSince } = question;
  if (question.fallback?.verified !== true || !(await documentsSince(base.tree))) return undefined;
  const commit = (await readCarryRecord(root, base.commit))?.from ?? base.commit;
  if (commit === base.commit)
    return { commit, tree: base.tree, source: snapshotIdentityOfTree(snapshot, base.tree) };
  if (
    (await readWaiverRecord(root, commit)) !== undefined ||
    !(await isAncestor(root, commit, base.commit))
  )
    return undefined;
  const tree = text(await sourceGit(root, ['rev-parse', '--verify', `${commit}^{tree}`]));
  if (
    !(await documentsSince(tree)) ||
    (await judgeChangesBetween(root, commit, snapshot.tree)).length
  )
    return undefined;
  return { commit, tree, source: snapshotIdentityOfTree(snapshot, tree) };
}

/**
 * The nearest first-parent ancestor of the candidate, published or not, whose own
 * gate is complete and clean. The walk stops at the first commit the candidate is
 * not documents-only from, or judged differently from, so nothing carries across
 * either; a side branch is never walked.
 */
async function nearestCleanAncestor(question: CarryQuestion): Promise<PlanCarry | undefined> {
  const { root, snapshot, head, documentsSince } = question;
  const probe = question.request.cleanGate;
  if (probe === undefined) return undefined;
  const commits = text(
    await sourceGit(root, [
      'rev-list',
      '--first-parent',
      `--max-count=${String(MAX_CARRY_WALK)}`,
      head,
    ])
  )
    .split('\n')
    .filter(Boolean);
  for (const commit of commits) {
    const tree = text(await sourceGit(root, ['rev-parse', '--verify', `${commit}^{tree}`]));
    if (tree === snapshot.tree) continue;
    if (
      !(await documentsSince(tree)) ||
      (await judgeChangesBetween(root, commit, snapshot.tree)).length > 0
    )
      return undefined;
    const source = snapshotIdentityOfTree(snapshot, tree);
    if (await probe(commit, tree, source)) return { commit, tree, source };
  }
  return undefined;
}

/**
 * Whose gate evidence a documents-only candidate carries: the default gate's
 * verified base when it can, else the nearest complete ancestor. Never with a
 * named base, and never when anything that decides the gate moved.
 */
async function carryOrigin(question: CarryQuestion): Promise<PlanCarry | undefined> {
  const { request } = question;
  if (request.tier !== 'gate' || request.base !== undefined || question.changes.length > 0)
    return undefined;
  return (await verifiedOrigin(question)) ?? (await nearestCleanAncestor(question));
}

export interface PlanRequest {
  /** The checkout whose Git history a base is resolved in. */
  root: string;
  snapshot: AuthoredSnapshot;
  tier: ProofTier;
  base?: string;
  /** The commit to resolve a default base from, when not this checkout's `HEAD`. */
  head?: string;
  tests?: readonly string[];
  control?: TaskControl;
  mode?: 'dev' | 'debug' | 'release';
  /** At task tier, how many consumers over the limit a recorded sample runs. */
  sample?: number;
  /** At a gate, what says an ancestor's own evidence is complete, so a carry can start there. */
  cleanGate?: CleanGateProbe;
}

/**
 * The engine path each changed project-root test runs from, which is where the
 * captured furnace.json deploys it. A test it deploys nowhere has no entry.
 */
async function deployedTests(
  snapshot: AuthoredSnapshot,
  changed: readonly ChangedPath[]
): Promise<Record<string, string>> {
  const roots = changed.filter(
    (change) => change.tree === 'root' && !change.deleted && isTestPath(change.path)
  );
  const input = snapshot.inputs.find((entry) => entry.path === 'furnace.json');
  if (roots.length === 0 || input === undefined) return {};
  const raw = (await readSourceBlobs(snapshot.repository, [input.blob])).get(input.blob);
  if (raw === undefined) throw new GeneralError(`proof-object-unavailable: ${input.blob}`);
  const config = validateFurnaceConfig(JSON.parse(raw.toString('utf8')) as unknown);
  const deployed: Record<string, string> = {};
  for (const { path } of roots) {
    const target = deployedComponentPath(path, config);
    if (target !== undefined) deployed[path] = target;
  }
  return deployed;
}

/** What a caller named, in the engine's terms. */
function namedInputs(
  request: Pick<PlanRequest, 'tests' | 'control' | 'sample'>,
  sourceRoot: string
): { named: string[]; control: TaskControl | undefined; sampled: { sample?: number } } {
  const engineRelative = (path: string): string => {
    const stripped = path
      .replace(/^engine\//, '')
      .replace(new RegExp(`^${escapeRegex(sourceRoot)}/`), '');
    assertSourcePath(stripped);
    return stripped;
  };
  return {
    named: [...new Set((request.tests ?? []).map(engineRelative))],
    sampled: request.sample === undefined ? {} : { sample: request.sample },
    control:
      request.control === undefined
        ? undefined
        : { ...request.control, test: engineRelative(request.control.test) },
  };
}

/** What a report has to say about its base and its declaration, beyond the gate's own obligation. */
function baseNotes(
  tier: ProofTier,
  changes: readonly string[],
  fallback: DefaultBase | undefined
): string[] {
  return [
    ...(changes.length > 0 && tier === 'task'
      ? [`What the gate requires changes here: ${changes.join('; ')}.`]
      : []),
    ...(fallback?.note === undefined ? [] : [fallback.note]),
  ];
}

/**
 * The plan for an authenticated snapshot, as the same pure function every time:
 * a completion check recomputes it, so a plan cannot be narrowed by hand.
 */
export async function planCapturedSource(request: PlanRequest): Promise<ProofPlan> {
  const { root, snapshot, tier } = request;
  const { config } = snapshot;
  const sources = config.sources;
  if (sources === undefined) throw new GeneralError('proof-authored-mode-required');
  const candidate = config.proof;
  const head = request.head ?? (await resolveCommit(root, 'HEAD'));
  if (head === undefined) throw new GeneralError('proof-base-required: this checkout has no HEAD');
  const { base, fallback } = await resolveBase(root, {
    tier,
    head,
    ...(candidate === undefined ? {} : { proof: candidate }),
    ...(request.base === undefined ? {} : { named: request.base }),
  });
  const raw = await changedPaths(root, snapshot, base.tree);
  const live = snapshot.files.flatMap((file) =>
    file.blob === undefined || file.kind === 'delete' ? [] : [{ path: file.path, blob: file.blob }]
  );
  const tests = live.filter((file) => isTestPath(file.path));
  const manifests = live.filter((file) => isTestManifestPath(file.path));
  // What a candidate has to answer to comes from history, whichever base a caller compares with.
  const { proof, notes, changes } = await answeredDeclaration(
    root,
    fallback?.commit ?? base.commit,
    snapshot.tree,
    candidate,
    {
      tests: tests.map((file) => file.path),
      deleted: new Set(raw.filter((change) => change.deleted).map((change) => change.path)),
    }
  );
  if (fallback?.selfDeclared === true && base.commit === fallback.commit)
    changes.push(`the main branch ${candidate?.mainBranch ?? ''} is named only by this candidate`);
  notes.push(...baseNotes(tier, changes, fallback));
  const mode = request.mode ?? (tier === 'gate' ? proof.gate?.mode : undefined);
  const { named, control, sampled } = namedInputs(request, sources.root);
  const diffs = [
    ...(proof.gate?.controls ?? []).map((entry) => entry.diff),
    ...(control === undefined ? [] : [control.diff]),
  ];
  const noneRoutes = [...(proof.noneRoutes ?? []), ...declaredInputs(proof), ...diffs];
  const classify = (changes: readonly ChangedPath[]): ChangedPath[] =>
    changes.map((change) =>
      change.tree === 'root' && change.route === 'unknown'
        ? { ...change, route: rootRoute(change.path, noneRoutes) }
        : change
    );
  const changed = classify(raw);
  const judged = new Set([...declaredInputs(proof), ...diffs, ...NODE_PACKAGE_FILES]);
  const carry = await carryOrigin({
    root,
    request,
    snapshot,
    head,
    base,
    fallback,
    changes,
    documentsSince: async (tree) =>
      onlyDocuments(
        tree === base.tree ? changed : classify(await changedPaths(root, snapshot, tree)),
        judged,
        sources.metadataRoot
      ),
  });
  const changedSet = new Set(changed.map((change) => change.path));
  const touched = live.filter((file) => changedSet.has(file.path) && !isTestPath(file.path));
  const diffInputs = snapshot.inputs.filter((input) => diffs.includes(input.path));
  const blobs = await readSourceBlobs(snapshot.repository, [
    ...tests.map((file) => file.blob),
    ...touched.map((file) => file.blob),
    ...manifests.map((file) => file.blob),
    ...diffInputs.map((input) => input.blob),
  ]);
  const content = (blob: string): string => {
    const bytes = blobs.get(blob);
    if (bytes === undefined) throw new GeneralError(`proof-object-unavailable: ${blob}`);
    return bytes.includes(0) ? '' : bytes.toString('utf8');
  };
  const planFile = (file: { path: string; blob: string }): { path: string; content: string } => ({
    path: file.path,
    content: content(file.blob),
  });
  for (const diff of diffs)
    if (!diffInputs.some((input) => input.path === diff))
      throw new GeneralError(
        `proof-control-not-captured: ${diff} is not in this capture. Commit it, or name it with --path.`
      );
  return createProofPlan({
    tier,
    source: snapshot.id,
    base,
    compiled: compiledSourceDigest(
      snapshot,
      buildRecipeDigest(
        mode === undefined ? {} : { build: { mode, brand: config.binaryName } },
        snapshot
      )
    ),
    changed,
    tests: tests.map(planFile),
    touched: touched.map(planFile),
    manifests: manifests.map(planFile),
    named,
    deployed: await deployedTests(snapshot, changed),
    proof,
    notes,
    ...(mode === undefined ? {} : { mode }),
    ...(config.check?.maxWarnings?.lint === undefined
      ? {}
      : { lintMaxWarnings: config.check.maxWarnings.lint }),
    ...(await typecheckInput(snapshot)),
    ...(tier === 'gate'
      ? { declarationChanges: changes, check: fullCheckContractForSnapshot(snapshot) }
      : {}),
    ...(control === undefined ? {} : { control }),
    ...sampled,
    ...(carry === undefined ? {} : { carry }),
    controlTargets: Object.fromEntries(
      diffInputs.map((input) => [input.path, diffTargets(content(input.blob))])
    ),
  });
}
