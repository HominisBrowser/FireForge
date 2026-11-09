// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../../errors/base.js';
import { sourceGit, sourceGitStatus } from '../authored/git.js';

export const VERIFIED_REF = 'refs/fireforge/verified';
/** One blob per commit published with waived machine obligations, beside the ref it explains. */
const WAIVERS_REF = 'refs/fireforge/verified-waivers';
/** One blob per commit published on evidence carried from an earlier verified commit. */
const CARRIES_REF = 'refs/fireforge/verified-carries';

/** What a publication with waivers leaves behind, so the ref never reads as cleaner than it is. */
export interface WaiverRecord {
  commit: string;
  /** The last commit published with nothing waived. A next gate compares with this one. */
  clean?: string;
  note: string;
  by: string;
  at: string;
  waived: Array<{ obligation: string; note: string; by: string; at: string }>;
}

/** Whether a commit exists under this name, and which. */
export async function resolveCommit(root: string, name: string): Promise<string | undefined> {
  const { code, stdout } = await sourceGitStatus(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${name}^{commit}`,
  ]);
  return code === 0 ? stdout.toString('utf8').trim() : undefined;
}

/** The current verified commit, or undefined before anything was published. */
export const readVerified = (root: string): Promise<string | undefined> =>
  resolveCommit(root, VERIFIED_REF);

/** @throws When Git cannot answer, as opposed to answering no */
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const { code, stderr } = await sourceGitStatus(root, [
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ]);
  if (code !== 0 && code !== 1) throw new GeneralError(`proof-git-ancestry: ${stderr}`);
  return code === 0;
}

/** A JSON blob beside the verified ref, one per commit. */
async function readRecord<T>(root: string, ref: string): Promise<T | undefined> {
  const { code, stdout } = await sourceGitStatus(root, ['cat-file', 'blob', ref]);
  return code === 0 ? (JSON.parse(stdout.toString('utf8')) as T) : undefined;
}

async function writeRecord(root: string, ref: string, record: unknown): Promise<void> {
  const blob = await sourceGit(
    root,
    ['hash-object', '-w', '--stdin', '--no-filters'],
    `${JSON.stringify(record, null, 2)}\n`
  );
  await sourceGit(root, ['update-ref', ref, blob.toString('utf8').trim()]);
}

const waiverRef = (commit: string): string => `${WAIVERS_REF}/${commit}`;

/** The waivers a commit was published with, if it was. */
export const readWaiverRecord = (root: string, commit: string): Promise<WaiverRecord | undefined> =>
  readRecord(root, waiverRef(commit));

/** Records a publication's waivers. Written before the ref moves, so a crash overstates them. */
export const writeWaiverRecord = (root: string, record: WaiverRecord): Promise<void> =>
  writeRecord(root, waiverRef(record.commit), record);

/** A clean publication of a commit discharges what it was earlier published with. */
export async function clearWaiverRecord(root: string, commit: string): Promise<void> {
  await sourceGit(root, ['update-ref', '-d', waiverRef(commit)]);
}

/** What a publication on carried evidence leaves behind, so a later carry starts from the evidence itself. */
export interface CarryRecord {
  commit: string;
  /** The verified commit whose evidence met the carried obligations. */
  from: string;
  carried: string[];
  by: string;
  at: string;
}

const carryRef = (commit: string): string => `${CARRIES_REF}/${commit}`;

/** The commit whose evidence a published commit was carried from, if it was. */
export const readCarryRecord = (root: string, commit: string): Promise<CarryRecord | undefined> =>
  readRecord(root, carryRef(commit));

/** Records a publication's carry. Written before the ref moves, like a waiver record. */
export const writeCarryRecord = (root: string, record: CarryRecord): Promise<void> =>
  writeRecord(root, carryRef(record.commit), record);

/** A publication on its own evidence discharges an earlier carry. */
export async function clearCarryRecord(root: string, commit: string): Promise<void> {
  await sourceGit(root, ['update-ref', '-d', carryRef(commit)]);
}

/** The newest verified commit with nothing waived: what the next gate has to compare with. */
export async function lastCleanVerified(root: string): Promise<string | undefined> {
  const verified = await readVerified(root);
  if (verified === undefined) return undefined;
  const record = await readWaiverRecord(root, verified);
  return record === undefined ? verified : record.clean;
}
