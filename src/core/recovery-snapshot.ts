// SPDX-License-Identifier: EUPL-1.2
/**
 * Private recovery snapshots taken before a destructive engine operation.
 *
 * `reset`, `discard` and `rebase --abort` overwrite or delete work-tree files
 * that Git never recorded. A snapshot commits the work tree (tracked changes
 * and untracked files, ignored files excluded) under
 * `refs/fireforge/recovery/<timestamp>-<operation>`, built with a private
 * index so the checkout's own index, HEAD and branches are untouched. The
 * newest {@link KEPT_SNAPSHOTS} are kept.
 */
import { toError } from '../utils/errors.js';
import { info, verbose, warn } from '../utils/logger.js';
import { git } from './git-base.js';
import { withPrivateGitIndex } from './git-readonly-index.js';

const RECOVERY_REF_PREFIX = 'refs/fireforge/recovery/';
const KEPT_SNAPSHOTS = 20;
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'FireForge',
  GIT_AUTHOR_EMAIL: 'fireforge@localhost',
  GIT_COMMITTER_NAME: 'FireForge',
  GIT_COMMITTER_EMAIL: 'fireforge@localhost',
};

/** Result of a snapshot: the ref that holds it. */
export interface RecoverySnapshot {
  ref: string;
  commit: string;
}

/**
 * Commits the work tree (or only `paths`) under a private recovery ref and
 * returns it. Returns undefined, after a warning, when the snapshot could not
 * be taken, or when the work tree equals HEAD: the destructive operation the operator asked for still proceeds.
 *
 * @param engineDir - Engine checkout
 * @param operation - Short operation label recorded in the ref name
 * @param paths - Restrict the snapshot to these engine-relative paths
 */
export async function takeRecoverySnapshot(
  engineDir: string,
  operation: string,
  paths?: readonly string[]
): Promise<RecoverySnapshot | undefined> {
  try {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
    const ref = `${RECOVERY_REF_PREFIX}${stamp}-${operation.replace(/[^a-z0-9]+/gi, '-')}`;
    const commit = await withPrivateGitIndex(engineDir, async () => {
      await git(['add', '-A', ...(paths !== undefined ? ['--', ...paths] : [])], engineDir);
      const tree = (await git(['write-tree'], engineDir)).trim();
      // Nothing to lose when the work tree equals HEAD.
      if (tree === (await git(['rev-parse', 'HEAD^{tree}'], engineDir)).trim()) return undefined;
      return (
        await git(
          [
            'commit-tree',
            tree,
            '-p',
            'HEAD',
            '-m',
            `fireforge recovery snapshot before ${operation}`,
          ],
          engineDir,
          { env: SNAPSHOT_IDENTITY }
        )
      ).trim();
    });
    if (commit === undefined) return undefined;
    await git(['update-ref', ref, commit], engineDir);
    await pruneSnapshots(engineDir);
    info(`Recovery snapshot ${ref} (restore a path with: git -C engine checkout ${ref} -- <path>)`);
    return { ref, commit };
  } catch (error: unknown) {
    warn(`Could not take a recovery snapshot before ${operation}: ${toError(error).message}`);
    return undefined;
  }
}

async function pruneSnapshots(engineDir: string): Promise<void> {
  try {
    const refs = (
      await git(['for-each-ref', '--format=%(refname)', RECOVERY_REF_PREFIX], engineDir)
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .sort();
    for (const stale of refs.slice(0, Math.max(0, refs.length - KEPT_SNAPSHOTS))) {
      await git(['update-ref', '-d', stale], engineDir);
    }
  } catch (error: unknown) {
    verbose(`Recovery snapshot pruning skipped: ${toError(error).message}`);
  }
}
