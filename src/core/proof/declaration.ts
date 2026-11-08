// SPDX-License-Identifier: EUPL-1.2
import { posix } from 'node:path';

import type {
  ProofAcceptanceConfig,
  ProofConfig,
  ProofControlConfig,
  ProofGateConfig,
  ProofLaneConfig,
  ProofStressConfig,
} from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { digest, sourceGit, sourceGitStatus } from '../authored/git.js';
import { parseProofConfig } from '../config-validate-proof.js';
import { OUTPUT_PLACEHOLDER } from '../jobs/step-validate.js';

/** What a tree of the project declares about its proof. */
export interface Declaration {
  proof?: ProofConfig;
  /** The `check` section as written: what a gate's final check is allowed to leave out. */
  check?: unknown;
  /** The `patchLint` section as written: what the final check's lint enforces. */
  patchLint?: unknown;
  /** The `patchPolicy` section as written: what the final check's verify enforces. */
  patchPolicy?: unknown;
  /** The `typecheck` section as written: what the final check's project pass holds to. */
  typecheck?: unknown;
  /** Why a declaration could not be read, which leaves nothing to compare a candidate with. */
  unreadable?: string;
}

/**
 * Reads `fireforge.json` from a commit or tree, not from a checkout, so nothing a
 * candidate writes can answer for its base.
 */
export async function readDeclaration(root: string, treeish: string): Promise<Declaration> {
  const { code, stdout } = await sourceGitStatus(root, ['show', `${treeish}:fireforge.json`]);
  if (code !== 0) return {};
  try {
    const raw = JSON.parse(stdout.toString('utf8')) as Record<string, unknown>;
    return {
      ...(raw['proof'] === undefined ? {} : { proof: parseProofConfig(raw['proof']) }),
      ...(raw['check'] === undefined ? {} : { check: raw['check'] }),
      ...(raw['patchLint'] === undefined ? {} : { patchLint: raw['patchLint'] }),
      ...(raw['patchPolicy'] === undefined ? {} : { patchPolicy: raw['patchPolicy'] }),
      ...(raw['typecheck'] === undefined ? {} : { typecheck: raw['typecheck'] }),
    };
  } catch (error) {
    return { unreadable: toError(error).message };
  }
}

/** What the candidate's tree holds, for telling a kept declaration from one gone with its files. */
interface CandidateFiles {
  tests: readonly string[];
  deleted: ReadonlySet<string>;
}

type LaneShape = Pick<ProofLaneConfig, 'files' | 'exclude' | 'owns' | 'quiet' | 'validate'>;

const union = <T>(a: readonly T[] = [], b: readonly T[] = []): T[] => [...new Set([...a, ...b])];

/** A pattern from the base still has something to run: a glob matching, or a path not deleted. */
const stillRuns = (pattern: string, files: CandidateFiles): boolean =>
  /[*?]/.test(pattern)
    ? files.tests.some((path) => matchesAnyGlob(path, [pattern]))
    : !files.deleted.has(pattern);

/** The wider of two scopes: no `owns` means every change. */
const widerOwns = (a: readonly string[] | undefined, b: readonly string[] | undefined): string[] =>
  a === undefined || b === undefined ? [] : union(a, b);

/** A lane in both: the candidate's shape over the wider roster. A file only leaves when both exclude it. */
function widenLane<T extends LaneShape>(base: T, candidate: T, files: CandidateFiles): T {
  const owns = widerOwns(base.owns, candidate.owns);
  const exclude = (candidate.exclude ?? []).filter((path) => base.exclude?.includes(path));
  const validate = candidate.validate ?? base.validate;
  const merged: T = {
    ...candidate,
    files: union(
      candidate.files,
      base.files.filter((pattern) => stillRuns(pattern, files))
    ),
    ...(base.quiet === true || candidate.quiet === true ? { quiet: true } : {}),
    ...(validate === undefined ? {} : { validate }),
  };
  if (owns.length === 0) delete merged.owns;
  else merged.owns = owns;
  if (exclude.length === 0) delete merged.exclude;
  else merged.exclude = exclude;
  return merged;
}

/** Declarations by ID: the candidate's in its order, then what only the base still holds. */
function mergeById<T extends { id: string }>(
  base: readonly T[] = [],
  candidate: readonly T[] = [],
  both: (base: T, candidate: T) => T,
  kept: (base: T) => T | undefined,
  label: string,
  notes: string[]
): T[] {
  const merged = candidate.map((entry) => {
    const earlier = base.find(({ id }) => id === entry.id);
    return earlier === undefined ? entry : both(earlier, entry);
  });
  for (const entry of base) {
    if (candidate.some(({ id }) => id === entry.id)) continue;
    const retained = kept(entry);
    notes.push(
      retained === undefined
        ? `${label} ${entry.id} is gone from the candidate with everything it ran.`
        : `${label} ${entry.id} is gone from the candidate, and still applies until that lands.`
    );
    if (retained !== undefined) merged.push(retained);
  }
  return merged;
}

/** A lane only the base declares keeps the patterns that can still run. */
function keptRoster<T extends LaneShape>(lane: T, files: CandidateFiles): T | undefined {
  const roster = lane.files.filter((pattern) => stillRuns(pattern, files));
  return roster.length === 0 ? undefined : { ...lane, files: roster };
}

function mergeStress(
  base: ProofStressConfig,
  candidate: ProofStressConfig,
  files: CandidateFiles
): ProofStressConfig {
  const context = union(
    candidate.context,
    base.context?.filter((path) => !files.deleted.has(path))
  );
  return {
    ...widenLane(base, candidate, files),
    repeat: Math.max(base.repeat, candidate.repeat),
    ...(context.length === 0 ? {} : { context }),
  };
}

function mergeAcceptance(
  base: ProofAcceptanceConfig,
  candidate: ProofAcceptanceConfig
): ProofAcceptanceConfig {
  const owns = widerOwns(base.owns, candidate.owns);
  const evidence = union(candidate.evidence, base.evidence);
  const merged: ProofAcceptanceConfig = {
    ...candidate,
    ...(evidence.length === 0 ? {} : { evidence }),
  };
  if (owns.length === 0) delete merged.owns;
  else merged.owns = owns;
  return merged;
}

const mergeControl = (
  base: ProofControlConfig,
  candidate: ProofControlConfig
): ProofControlConfig =>
  base.always === true && candidate.always !== true ? { ...candidate, always: true } : candidate;

function mergeGate(
  base: ProofGateConfig | undefined,
  candidate: ProofGateConfig | undefined,
  files: CandidateFiles,
  notes: string[]
): ProofGateConfig {
  const build = base?.build === 'full' ? 'full' : (candidate?.build ?? base?.build);
  const mode = candidate?.mode ?? base?.mode;
  const quiet = base?.check?.quiet === true || candidate?.check?.quiet === true;
  return {
    ...(build === undefined ? {} : { build }),
    ...(mode === undefined ? {} : { mode }),
    ...(quiet ? { check: { quiet } } : {}),
    lanes: mergeById(
      base?.lanes,
      candidate?.lanes,
      (a, b) => widenLane(a, b, files),
      (lane) => keptRoster(lane, files),
      'Lane',
      notes
    ),
    stress: mergeById(
      base?.stress,
      candidate?.stress,
      (a, b) => mergeStress(a, b, files),
      (stress) => keptRoster(stress, files),
      'Stress',
      notes
    ),
    controls: mergeById(
      base?.controls,
      candidate?.controls,
      mergeControl,
      (control) =>
        files.deleted.has(control.diff) || files.deleted.has(control.test) ? undefined : control,
      'Control',
      notes
    ),
    runs: mergeById(
      base?.runs,
      candidate?.runs,
      // As on a lane: dropping a validator applies once the dropping commit is verified.
      (a, b) =>
        b.validate === undefined && a.validate !== undefined ? { ...b, validate: a.validate } : b,
      (run) => run,
      'Run',
      notes
    ),
    acceptance: mergeById(
      base?.acceptance,
      candidate?.acceptance,
      mergeAcceptance,
      (entry) => entry,
      'Acceptance',
      notes
    ),
  };
}

/**
 * The declaration a candidate answers to: the union of its base's and its own, so
 * what it adds applies at once and what it removes applies until that removal has
 * itself been verified and become the base. A route counts as having no runtime
 * effect only when both say so, since that takes work out of the plan.
 */
export function effectiveProof(
  base: ProofConfig | undefined,
  candidate: ProofConfig | undefined,
  files: CandidateFiles
): { proof: ProofConfig; notes: string[] } {
  const notes: string[] = [];
  const noneRoutes = (candidate?.noneRoutes ?? []).filter((route) =>
    base?.noneRoutes?.includes(route)
  );
  const consumerLimit = candidate?.consumerLimit ?? base?.consumerLimit;
  return {
    proof: {
      ...(consumerLimit === undefined ? {} : { consumerLimit }),
      ...(noneRoutes.length === 0 ? {} : { noneRoutes }),
      gate: mergeGate(base?.gate, candidate?.gate, files, notes),
    },
    notes,
  };
}

/** Which of the sections that decide a gate differ, for the person asked to accept that. */
export function declarationChange(base: Declaration, candidate: Declaration): string[] {
  const changes: string[] = [];
  if (base.unreadable !== undefined)
    changes.push(`the base's declaration cannot be read: ${base.unreadable}`);
  for (const section of ['proof', 'check', 'patchLint', 'patchPolicy', 'typecheck'] as const)
    if (digest(base[section] ?? {}) !== digest(candidate[section] ?? {})) changes.push(section);
  return changes;
}

/** The words of a command that could name a file: `--flag=path` counts for its path. */
const namedPaths = (words: readonly string[], cwd = ''): string[] =>
  words
    .filter((word) => !word.includes(OUTPUT_PLACEHOLDER))
    .map((word) => word.replace(/^[^/=]*=/, ''))
    .filter((word) => word !== '' && !word.startsWith('/'))
    .map((word) => posix.join(cwd, word))
    .filter((path) => path !== '.' && !path.startsWith('..'));

/** What a declaration's extra check steps name: each is one shell line, split as far as words go. */
function extraStepPaths(check: unknown): string[] {
  const steps = (check as { extraSteps?: unknown } | undefined)?.extraSteps;
  if (!Array.isArray(steps)) return [];
  return (steps as Array<{ command?: unknown; cwd?: unknown }>).flatMap(({ command, cwd }) =>
    typeof command === 'string'
      ? namedPaths(command.split(/[\s;|&()<>"'`]+/), typeof cwd === 'string' ? cwd : '')
      : []
  );
}

/** The type declarations a check is held to: a loosened shim passes what it should refuse. */
function shimPaths({ patchLint, typecheck }: Declaration): string[] {
  const lint = patchLint as { checkJsExtraShim?: unknown; checkJsTestShim?: unknown } | undefined;
  const types = typecheck as
    { extraShim?: unknown; projectOverrides?: Record<string, unknown> } | undefined;
  return [
    lint?.checkJsExtraShim,
    lint?.checkJsTestShim,
    types?.extraShim,
    ...Object.values(types?.projectOverrides ?? {}),
  ].filter((path): path is string => typeof path === 'string');
}

/** Every path a declaration's judges name: validators, control diffs, extra check steps and shims. */
function judgePaths(declaration: Declaration): string[] {
  const { proof, check } = declaration;
  const gate = proof?.gate;
  return [
    ...shimPaths(declaration),
    ...[...(gate?.lanes ?? []), ...(gate?.stress ?? []), ...(gate?.runs ?? [])].flatMap((lane) =>
      namedPaths(lane.validate?.command ?? [])
    ),
    ...(gate?.controls ?? []).map((control) => control.diff),
    ...extraStepPaths(check),
  ];
}

/** Each of these paths a tree holds as a file, with its blob. */
async function fileBlobs(
  root: string,
  treeish: string,
  paths: readonly string[]
): Promise<Map<string, string>> {
  const listed = await sourceGit(root, ['ls-tree', '-z', treeish, '--', ...paths]);
  const blobs = new Map<string, string>();
  for (const row of listed.toString('utf8').split('\0')) {
    const match = /^\d+ blob (\S+)\t(.+)$/s.exec(row);
    if (match?.[1] !== undefined && match[2] !== undefined) blobs.set(match[2], match[1]);
  }
  return blobs;
}

/**
 * The files a gate's judges are, where base and candidate differ. A file a tree
 * does not hold is just a word of the command, unless the other tree holds it.
 * Only the files a command names: what they import is not followed.
 */
async function changedJudges(
  root: string,
  base: { treeish: string; declaration: Declaration },
  candidate: { treeish: string; declaration: Declaration }
): Promise<string[]> {
  const paths = [
    ...new Set([...judgePaths(base.declaration), ...judgePaths(candidate.declaration)]),
  ];
  if (paths.length === 0) return [];
  const before = await fileBlobs(root, base.treeish, paths);
  const after = await fileBlobs(root, candidate.treeish, paths);
  return paths.filter((path) => before.get(path) !== after.get(path)).sort();
}

/**
 * Everything that decides a gate and differs between two trees: the sections that
 * decide it, and the files its judges name.
 */
async function judgeChanges(
  root: string,
  history: { treeish: string; declaration: Declaration },
  candidate: { treeish: string; declaration: Declaration }
): Promise<string[]> {
  return [
    ...declarationChange(history.declaration, candidate.declaration),
    ...(await changedJudges(root, history, candidate)).map(
      (path) => `the file ${path}, which judges it`
    ),
  ];
}

/** What decides a gate and differs between a commit and a tree, read from both. */
export async function judgeChangesBetween(
  root: string,
  history: string,
  tree: string
): Promise<string[]> {
  return judgeChanges(
    root,
    { treeish: history, declaration: await readDeclaration(root, history) },
    { treeish: tree, declaration: await readDeclaration(root, tree) }
  );
}

export interface AnsweredDeclaration {
  proof: ProofConfig;
  notes: string[];
  changes: string[];
}

/**
 * Reads the base's declaration and the candidate's own, and states what the candidate answers to.
 *
 * @param root - The checkout whose object store holds both
 * @param history - The commit whose declaration a candidate answers to
 * @param tree - The candidate's captured tree
 * @param candidate - Its parsed declaration
 * @param files - What it holds and what it deleted
 */
export async function answeredDeclaration(
  root: string,
  history: string,
  tree: string,
  candidate: ProofConfig | undefined,
  files: CandidateFiles
): Promise<AnsweredDeclaration> {
  const declared = await readDeclaration(root, history);
  const captured = await readDeclaration(root, tree);
  const { proof, notes } = effectiveProof(declared.proof, candidate, files);
  return {
    proof,
    notes,
    changes: await judgeChanges(
      root,
      { treeish: history, declaration: declared },
      { treeish: tree, declaration: captured }
    ),
  };
}
