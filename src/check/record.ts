// SPDX-License-Identifier: EUPL-1.2
/**
 * What the gate keeps between invocations.
 *
 * - The result of the last full run on a commit:
 *   `.fireforge/gate/<commit>/result.json`, beside the artifacts of that
 *   run. It belongs to one checkout and stands only for the tree and the
 *   FireForge version it was produced with.
 * - The decisions people recorded for a tree: one git ref per tree,
 *   `refs/fireforge/accepted/<tree>`, pointing at a JSON blob of the
 *   acceptances by ID. Refs are shared by every worktree of the repository.
 * - `refs/fireforge/verified`: the last commit that passed.
 */
import { join } from 'node:path';

import { packageVersion } from '../cli/version.js';
import { readBlobs, resolveRevision, updateRef, writeBlobs } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, pathInfo, remove } from '../kernel/fs.js';
import { parseJson, readJsonIfExists, stringifyJson, writeJson } from '../kernel/json.js';
import { type Infer, s } from '../kernel/schema.js';
import type { Project } from '../project/index.js';

/** The ref a passed gate moves. */
export const VERIFIED_REF = 'refs/fireforge/verified';

const ACCEPTED_REF_PREFIX = 'refs/fireforge/accepted/';

/** Gate runs whose artifacts a checkout keeps. */
const KEPT_RUNS = 5;

const entrySchema = s.object({
  /** `check`, `build`, or `kind:id` of a declared lane, stress run, control or run. */
  id: s.string({ min: 1 }),
  status: s.enum(['pass', 'fail', 'skipped']),
  detail: s.string(),
  durationMs: s.number({ min: 0 }),
  /** The entry's directory of logs and outputs, relative to the run's directory. */
  artifacts: s.string().optional(),
});

/** One thing a gate run did and how it ended. */
export type GateEntry = Infer<typeof entrySchema>;

const resultSchema = s.object({
  commit: s.string({ min: 1 }),
  tree: s.string({ min: 1 }),
  /** The FireForge version that produced the result. */
  tool: s.string({ min: 1 }),
  finishedAt: s.string(),
  pass: s.boolean(),
  entries: s.array(entrySchema),
});

/** The recorded result of a full gate run. */
export type GateResult = Infer<typeof resultSchema>;

/**
 * The directory holding a commit's gate result and artifacts.
 *
 * @param project - The project
 * @param commit - The commit the gate ran on
 */
export function gateDir(project: Project, commit: string): string {
  return join(project.paths.stateDir, 'gate', commit);
}

/**
 * The recorded result of a commit, when it still stands: produced by this
 * FireForge version for the tree the commit has.
 *
 * @param project - The project
 * @param commit - The commit
 * @param tree - The commit's tree
 */
export async function readResult(
  project: Project,
  commit: string,
  tree: string
): Promise<GateResult | undefined> {
  const path = join(gateDir(project, commit), 'result.json');
  const result = await readJsonIfExists(path, resultSchema).catch(() => undefined);
  return result?.tree === tree && result.tool === (await packageVersion()) ? result : undefined;
}

/**
 * Records the result of a full run.
 *
 * @param project - The project
 * @param result - What ran, without the version, which is this one
 */
export async function writeResult(
  project: Project,
  result: Omit<GateResult, 'tool' | 'finishedAt'>
): Promise<GateResult> {
  const complete = {
    ...result,
    tool: await packageVersion(),
    finishedAt: new Date().toISOString(),
  };
  await writeJson(join(gateDir(project, result.commit), 'result.json'), complete);
  return complete;
}

/**
 * Empties the directory a run on `commit` writes to and drops the oldest
 * other runs past the number a checkout keeps.
 *
 * @param project - The project
 * @param commit - The commit about to be gated
 */
export async function prepareGateDir(project: Project, commit: string): Promise<string> {
  const root = join(project.paths.stateDir, 'gate');
  const dated: { name: string; mtimeMs: number }[] = [];
  for (const entry of await listDir(root)) {
    if (entry.kind !== 'directory' || entry.name === commit) continue;
    dated.push({
      name: entry.name,
      mtimeMs: (await pathInfo(join(root, entry.name)))?.mtimeMs ?? 0,
    });
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of dated.slice(KEPT_RUNS - 1)) await remove(join(root, stale.name));
  await remove(gateDir(project, commit));
  return gateDir(project, commit);
}

const acceptanceSchema = s.object({
  /** Who decided: the repository's `user.name`, else the login name. */
  by: s.string(),
  at: s.string(),
  note: s.string(),
  /** The commit that was checked out when the decision was recorded. */
  commit: s.string(),
});

/** One recorded decision. */
export type Acceptance = Infer<typeof acceptanceSchema>;

const acceptancesSchema = s.record(acceptanceSchema);

async function readAcceptanceBlob(
  repository: string,
  tree: string
): Promise<{ blob: string | undefined; accepted: Record<string, Acceptance> }> {
  const blob = await resolveRevision(repository, `${ACCEPTED_REF_PREFIX}${tree}`);
  if (blob === undefined) return { blob, accepted: {} };
  const content = (await readBlobs(repository, [blob])).get(blob);
  const source = `${ACCEPTED_REF_PREFIX}${tree}`;
  return {
    blob,
    accepted: acceptancesSchema.parse(parseJson(content?.toString('utf8') ?? '{}', { source }), {
      source,
    }),
  };
}

/**
 * The decisions recorded for a tree, by acceptance ID.
 *
 * @param repository - The repository's top directory
 * @param tree - The tree
 */
export async function readAcceptances(
  repository: string,
  tree: string
): Promise<Record<string, Acceptance>> {
  return (await readAcceptanceBlob(repository, tree)).accepted;
}

/**
 * Records a decision for a tree, replacing an earlier one with the same ID.
 *
 * @param repository - The repository's top directory
 * @param tree - The tree the decision is about
 * @param id - The acceptance ID
 * @param acceptance - Who, when, and their note
 * @throws `gate-accept-raced` (exit code 4) when another decision for the
 *   tree was recorded at the same moment
 */
export async function recordAcceptance(
  repository: string,
  tree: string,
  id: string,
  acceptance: Acceptance
): Promise<void> {
  const { blob, accepted } = await readAcceptanceBlob(repository, tree);
  const text = stringifyJson({ ...accepted, [id]: acceptance });
  const [next] = await writeBlobs(repository, [Buffer.from(text)]);
  const moved =
    next !== undefined &&
    (await updateRef(repository, `${ACCEPTED_REF_PREFIX}${tree}`, next, { expect: blob ?? null }));
  if (!moved) {
    throw new FireForgeError(
      'gate-accept-raced',
      'Another acceptance for this tree was recorded at the same moment.',
      { exitCode: ExitCode.GIT_ERROR, hint: 'Run the command again.' }
    );
  }
}
