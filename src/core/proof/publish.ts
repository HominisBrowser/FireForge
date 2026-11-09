// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { sourceGit, sourceGitStatus } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { readJson } from '../jobs/store.js';
import type { ProofStatus } from './evidence.js';
import type { ProofPlan } from './types.js';
import {
  type CarryRecord,
  clearCarryRecord,
  clearWaiverRecord,
  isAncestor,
  lastCleanVerified,
  readCarryRecord,
  readVerified,
  readWaiverRecord,
  VERIFIED_REF,
  type WaiverRecord,
  writeCarryRecord,
  writeWaiverRecord,
} from './verified.js';

export interface PublishResult {
  commit: string;
  previous?: string;
  rewritten: boolean;
}

/**
 * Moves the verified ref to a commit whose exact tree has complete evidence, which
 * the caller established. A compare-and-swap, so a concurrent publication refuses.
 * Only a fast-forward moves it, unless the caller states history was rewritten.
 * Waivers are recorded beside the ref, and the commit does not become the next
 * gate's base while they stand. Publishing that commit clean discharges them.
 * Carried evidence is recorded the same way, naming the commit it came from, and
 * publishing on the commit's own evidence discharges that.
 */
export async function advanceVerified(
  root: string,
  commit: string,
  allowRewrite: boolean,
  records: PublicationRecords = {}
): Promise<PublishResult> {
  const { waivers, carry } = records;
  if (waivers !== undefined) {
    const clean = await lastCleanVerified(root);
    await writeWaiverRecord(root, {
      ...waivers,
      commit,
      ...(clean === undefined ? {} : { clean }),
    });
  }
  if (carry !== undefined) await writeCarryRecord(root, { ...carry, commit });
  const result = await moveVerified(root, commit, allowRewrite);
  if (waivers === undefined && (await readWaiverRecord(root, commit)) !== undefined)
    await clearWaiverRecord(root, commit);
  if (carry === undefined && (await readCarryRecord(root, commit)) !== undefined)
    await clearCarryRecord(root, commit);
  return result;
}

interface PublicationRecords {
  waivers?: Omit<WaiverRecord, 'commit' | 'clean'>;
  carry?: Omit<CarryRecord, 'commit'>;
}

/** What a complete status leaves beside the ref: its waivers, and where carried evidence came from. */
export function publicationRecords(
  plan: ProofPlan,
  status: ProofStatus,
  note: string,
  by: string
): PublicationRecords {
  const at = new Date().toISOString();
  const waived = status.obligations.filter((entry) => entry.state === 'waived');
  const carried = status.obligations.filter((entry) => entry.carried !== undefined);
  return {
    ...(waived.length === 0
      ? {}
      : {
          waivers: {
            note,
            by,
            at,
            waived: waived.map((entry) => ({
              obligation: entry.id,
              note: entry.decision?.note ?? '',
              by: entry.decision?.by ?? '',
              at: entry.decision?.at ?? '',
            })),
          },
        }),
    ...(carried.length === 0 || plan.carry === undefined
      ? {}
      : { carry: { from: plan.carry.commit, carried: carried.map((entry) => entry.id), by, at } }),
  };
}

async function moveVerified(
  root: string,
  commit: string,
  allowRewrite: boolean
): Promise<PublishResult> {
  const previous = await readVerified(root);
  const forward = previous === undefined || (await isAncestor(root, previous, commit));
  if (!forward && !allowRewrite)
    throw new GeneralError(
      `proof-verified-not-ancestor: ${VERIFIED_REF} is at ${previous}, which ${commit} does not descend from. If history was rewritten, publish with --allow-rewrite.`
    );
  if (previous === commit) return { commit, previous, rewritten: false };
  const absent = '0'.repeat(commit.length);
  const { code, stderr } = await sourceGitStatus(root, [
    'update-ref',
    VERIFIED_REF,
    commit,
    previous ?? absent,
  ]);
  if (code !== 0)
    throw new GeneralError(
      `proof-publish-raced: ${VERIFIED_REF} moved during publication: ${stderr}`
    );
  return {
    commit,
    ...(previous === undefined ? {} : { previous }),
    rewritten: !forward,
  };
}

/** @returns The full commit a revision names, and its tree */
export async function commitTree(
  root: string,
  revision: string
): Promise<{ commit: string; tree: string }> {
  const { code, stdout } = await sourceGitStatus(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${revision}^{commit}`,
  ]);
  if (code !== 0) throw new GeneralError(`proof-publish-unknown-commit: ${revision}`);
  const commit = stdout.toString('utf8').trim();
  const tree = (await sourceGit(root, ['rev-parse', `${commit}^{tree}`])).toString('utf8').trim();
  return { commit, tree };
}

/** The sources the coordinator retained for a job with exactly this tree. */
export async function retainedSnapshotsOfTree(
  namespace: string,
  tree: string
): Promise<AuthoredSnapshot[]> {
  let names: string[];
  try {
    names = await readdir(join(namespace, 'snapshots'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const snapshots = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<AuthoredSnapshot>(join(namespace, 'snapshots', name)))
  );
  return snapshots.filter((snapshot) => snapshot.tree === tree);
}
