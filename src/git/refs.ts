// SPDX-License-Identifier: EUPL-1.2
/** Refs: moving them safely, listing them, and the recovery snapshots kept under them. */
import { randomId } from '../kernel/hash.js';
import { captureWorktree, commitTree } from './objects.js';
import { resolveRevision } from './repo.js';
import { git, gitFailure, gitResult } from './run.js';

/**
 * Points a ref at an object, or deletes it. With `expect`, the change is a
 * compare-and-swap: it happens only if the ref still holds `expect` (`null`:
 * only if the ref does not exist yet), so two writers cannot both win.
 *
 * @param cwd - The repository
 * @param ref - The full ref name (`refs/fireforge/verified`)
 * @param value - The object id, or null to delete the ref
 * @param options - `expect`
 * @returns False when `expect` did not hold and nothing changed
 */
export async function updateRef(
  cwd: string,
  ref: string,
  value: string | null,
  options: { expect?: string | null } = {}
): Promise<boolean> {
  const { expect } = options;
  const zero = '0'.repeat(value?.length ?? expect?.length ?? 40);
  const old = expect === undefined ? [] : [expect ?? zero];
  const args =
    value === null ? ['update-ref', '-d', ref, ...old] : ['update-ref', ref, value, ...old];
  const result = await gitResult(args, { cwd });
  if (result.exitCode === 0) return true;
  if (expect !== undefined && (await resolveRevision(cwd, ref)) !== (expect ?? undefined)) {
    return false;
  }
  throw gitFailure(args, result, cwd);
}

/**
 * The refs under a prefix with the objects they point at, sorted by name.
 *
 * @param cwd - The repository
 * @param prefix - A ref prefix (`refs/fireforge/recovery/`)
 */
export async function listRefs(
  cwd: string,
  prefix: string
): Promise<Array<{ ref: string; oid: string }>> {
  const output = await git(['for-each-ref', '--format=%(objectname) %(refname)', '--', prefix], {
    cwd,
  });
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.indexOf(' ');
      return { oid: line.slice(0, space), ref: line.slice(space + 1) };
    })
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** Where recovery snapshots live. */
export const RECOVERY_REF_PREFIX = 'refs/fireforge/recovery/';

/** What {@link saveRecoverySnapshot} saves and keeps. */
export interface RecoveryOptions {
  /** What is about to happen, recorded in the ref name and commit message (`reset`). */
  label: string;
  /** Only these paths; default the whole working tree. */
  paths?: readonly string[];
  /** How many snapshots to keep, newest first. Default 20. */
  keep?: number;
}

/**
 * Saves the working tree's current state (tracked changes and untracked
 * files, not ignored ones) as a commit on HEAD under
 * `refs/fireforge/recovery/<time>-<label>`, before an operation that would
 * destroy it. Built in a private index, so the repository's index, HEAD and
 * branches do not move. Older snapshots beyond `keep` are deleted.
 *
 * @param cwd - The repository
 * @param options - See {@link RecoveryOptions}
 * @returns The snapshot, or undefined when the paths equal HEAD and there is nothing to lose
 */
export async function saveRecoverySnapshot(
  cwd: string,
  options: RecoveryOptions
): Promise<{ ref: string; commit: string } | undefined> {
  const head = await resolveRevision(cwd, 'HEAD', 'commit');
  const headTree = head === undefined ? undefined : await resolveRevision(cwd, head, 'tree');
  const tree = await captureWorktree(cwd, {
    base: headTree ?? null,
    ...(options.paths !== undefined && { paths: options.paths }),
  });
  if (tree === headTree) return undefined;
  const commit = await commitTree(cwd, tree, {
    message: `fireforge recovery snapshot before ${options.label}`,
    parents: head === undefined ? [] : [head],
  });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
  const label = options.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const ref = `${RECOVERY_REF_PREFIX}${stamp}-${label}-${randomId().slice(0, 8)}`;
  await updateRef(cwd, ref, commit, { expect: null });
  const snapshots = await listRefs(cwd, RECOVERY_REF_PREFIX);
  for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - (options.keep ?? 20)))) {
    await updateRef(cwd, stale.ref, null);
  }
  return { ref, commit };
}
