// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { UnknownSlotError } from '../../errors/job.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { processHasExitedAsync, processIdentityAsync } from './process.js';
import type { ProcessIdentity } from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

/** The slot lock is held by a live process, so the work behind it has to wait. */
export class SlotBusyError extends Error {
  override readonly name = 'SlotBusyError';
}

/** Someone else holds a claim this process thought it held, so nothing it could do would release it. */
export class ClaimReplacedError extends Error {
  override readonly name = 'ClaimReplacedError';
}

export interface DirectoryClaim {
  owner: ProcessIdentity;
  nonce: string;
  jobId?: string;
}

const CLAIM_ATTEMPTS = 8;

const claimPath = (directory: string, generation: number): string =>
  join(directory, `exclusive.${String(generation)}`);

/** The highest claim generation in a directory, and whether its holder let go. */
async function readGenerations(directory: string): Promise<{ top: number; free: boolean }> {
  let top = 0;
  const free = new Set<number>();
  for (const name of await readdir(directory)) {
    const match = /^exclusive\.(\d+)(\.free)?$/.exec(name);
    if (match === null) continue;
    const generation = Number(match[1]);
    top = Math.max(top, generation);
    if (match[2] !== undefined) free.add(generation);
  }
  return { top, free: free.has(top) };
}

/**
 * Refuses while a generation's holder lives or cannot be established.
 *
 * @returns False when the claim went away, because a later generation replaced it
 * @throws {SlotBusyError} While the holder lives or cannot be established
 */
async function assertHolderGone(label: string, path: string): Promise<boolean> {
  let claim: DirectoryClaim;
  try {
    claim = await readJson<DirectoryClaim>(path);
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return false;
    throw new SlotBusyError(`${label} has an unreadable lock at ${path}`, { cause: error });
  }
  if (!(await processHasExitedAsync(claim.owner)))
    throw new SlotBusyError(
      `${label} is in use by process ${String(claim.owner.pid)}${claim.jobId ? ` (job ${claim.jobId})` : ''}`
    );
  return true;
}

/** Generations a newer one replaced. Nobody consults them, so a crash here costs nothing. */
async function retireGenerationsBelow(directory: string, generation: number): Promise<void> {
  for (const name of await readdir(directory)) {
    const match = /^exclusive\.(\d+)(\.free)?$/.exec(name);
    if (match !== null && Number(match[1]) < generation)
      await rm(join(directory, name), { force: true });
  }
}

/**
 * Takes the next generation of the claim. The holder is whoever holds the highest
 * generation, and that file is never moved or removed until a higher one exists,
 * so taking over from a dead holder never touches a live claim and a crash at any
 * point leaves a state the next contender can read. `link` gives each generation
 * one owner. A contender working from a stale listing can only link a number below
 * the current top, which the check after the link catches.
 *
 * @throws {SlotBusyError} When a live process holds the claim
 */
async function takeGeneration(directory: string, label: string, proposal: string): Promise<number> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const { top, free } = await readGenerations(directory);
    if (top > 0 && !free && !(await assertHolderGone(label, claimPath(directory, top)))) continue;
    const mine = top + 1;
    try {
      await link(proposal, claimPath(directory, mine));
    } catch (error) {
      if (getNodeErrorCode(error) === 'EEXIST') continue;
      throw error;
    }
    if ((await readGenerations(directory)).top > mine) {
      await rm(claimPath(directory, mine), { force: true });
      continue;
    }
    await retireGenerationsBelow(directory, mine);
    return mine;
  }
  throw new SlotBusyError(`${label} is contended; try again`);
}

/**
 * Takes the exclusive claim on a directory. A claim whose holder has exited is
 * taken over, whoever held it.
 *
 * @throws {SlotBusyError} When a live process holds it
 */
export async function claimDirectory(
  directory: string,
  label: string,
  claim?: { jobId: string }
): Promise<() => Promise<void>> {
  const owner = await processIdentityAsync(process.pid);
  if (owner === undefined) throw new Error('Cannot identify slot owner');
  const nonce = randomUUID();
  const proposal = join(directory, `claim-${nonce}.json`);
  await writeDurable(proposal, { owner, nonce, ...claim });
  let generation: number;
  try {
    generation = await takeGeneration(directory, label, proposal);
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(proposal, { force: true });
  }
  const held = claimPath(directory, generation);
  return async () => {
    const { top } = await readGenerations(directory);
    const current =
      top === generation
        ? await readJson<{ nonce: string }>(held).catch(() => undefined)
        : undefined;
    if (current?.nonce !== nonce) throw new ClaimReplacedError('Slot ownership was replaced');
    // A second name for the same bytes: letting go needs no new data, even on a full disk.
    await link(held, `${held}.free`).catch((error: unknown) => {
      if (getNodeErrorCode(error) !== 'EEXIST') throw error;
    });
  };
}

/** Who holds a directory's claim now, if anyone. Takes nothing. */
export async function claimHolder(directory: string): Promise<DirectoryClaim | undefined> {
  const { top, free } = await readGenerations(directory);
  if (top === 0 || free) return undefined;
  return readJson<DirectoryClaim>(claimPath(directory, top)).catch(() => undefined);
}

/**
 * All slot mutations use this guard, including creation, preparation, audit and
 * sealing. A name that was never a slot leaves nothing behind.
 *
 * @throws {SlotBusyError} When a live process holds the slot
 */
export async function acquireSlot(
  namespace: string,
  id: string,
  claim?: { jobId: string },
  options: { create?: boolean } = {}
): Promise<() => Promise<void>> {
  const directory = slotDirectory(namespace, id);
  if (options.create === true) await mkdir(directory, { recursive: true, mode: 0o700 });
  else {
    try {
      await lstat(directory);
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      throw new UnknownSlotError(
        `Slot ${id} does not exist; fireforge slot list shows what exists, and fireforge slot create ${id} makes it`,
        error
      );
    }
  }
  return claimDirectory(directory, `Slot ${id}`, claim);
}

/** Metadata no read can get through: the scheduler already reports such a slot as quarantined. */
export function slotMetadataUnreadable(error: unknown): boolean {
  return (
    error instanceof SyntaxError || ['ENOENT', 'EISDIR'].includes(getNodeErrorCode(error) ?? '')
  );
}

/**
 * Marks a slot unavailable until `slot restore`. Reads no more than it writes,
 * so one damaged field cannot stop the mark, and the first reason stays: it is
 * the one that explains the slot.
 */
export async function quarantineSlot(namespace: string, id: string, reason: string): Promise<void> {
  const path = join(slotDirectory(namespace, id), 'slot.json');
  const slot = await readJson<SlotRecord>(path);
  if (slot.quarantined != null) return;
  slot.quarantined = reason;
  await writeDurable(path, slot);
}

/** A job ended here without sealing: nothing is wrong yet, but the next admission audits first. */
export async function markSlotForAudit(namespace: string, id: string): Promise<void> {
  const path = join(slotDirectory(namespace, id), 'slot.json');
  const slot = await readJson<SlotRecord>(path);
  if (slot.requiresAudit === true) return;
  slot.requiresAudit = true;
  await writeDurable(path, slot);
}

/**
 * Forgets build state a build is about to overwrite, durably and before it
 * launches. If the build fails or is killed, the slot's records must not still
 * describe the previous binary: a later source restoring the anchored compiled
 * inputs would otherwise accept a `--ui` build over the failed build's objects.
 * `compiled` says whether the build can touch compiled output, and `tools` names
 * the native tools about to touch the object directory.
 */
export async function invalidateBuildIdentity(
  namespace: string,
  slot: SlotRecord,
  compiled: boolean,
  tools?: string
): Promise<void> {
  delete slot.trustedBuild;
  delete slot.packageSignature;
  slot.requiresBuild = true;
  if (compiled) {
    delete slot.fullBuildAnchor;
    slot.requiresFullBuild = true;
  }
  if (tools !== undefined) slot.objdirToolsDigest = tools;
  await writeDurable(join(slotDirectory(namespace, slot.id), 'slot.json'), slot);
}
