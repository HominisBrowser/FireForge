// SPDX-License-Identifier: EUPL-1.2
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { isSameProcess, processIdentityAsync } from './process.js';
import type { ProcessIdentity } from './schema.js';
import { claimDirectory, claimHolder, ClaimReplacedError, SlotBusyError } from './slot-lock.js';
import { ensurePrivateNamespace, readJson, writeDurable } from './store.js';

export interface Election {
  /** Increases with every election. It names sockets and records, and fences nothing. */
  epoch: number;
  owner: ProcessIdentity;
  release: () => Promise<void>;
}

/** Another supervisor holds the namespace: losing this race is how a second start is meant to end. */
export class ElectionLostError extends Error {
  override readonly name = 'ElectionLostError';
}

/** Where the election is held. */
export const electionDirectory = (namespace: string): string => join(namespace, 'election');

/** Says who holds the election, which is what the loser can act on. */
async function lostTo(directory: string): Promise<ElectionLostError> {
  const holder = await claimHolder(directory);
  if (holder === undefined) return new ElectionLostError('Supervisor election in progress');
  return new ElectionLostError(
    (await isSameProcess(holder.owner))
      ? `Supervisor already running (pid ${String(holder.owner.pid)})`
      : `Supervisor owner identity is uncertain (pid ${String(holder.owner.pid)})`
  );
}

/**
 * Elect one local supervisor. The claim changes hands only once its owner has
 * positively exited, and an owner that cannot be established refuses.
 *
 * @throws {ElectionLostError} When another supervisor holds or may hold the namespace
 */
export async function electSupervisor(namespace: string): Promise<Election> {
  await ensurePrivateNamespace(namespace);
  const owner = await processIdentityAsync(process.pid);
  if (owner === undefined) throw new Error('Cannot establish supervisor process identity');
  const directory = electionDirectory(namespace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await claimDirectory(directory, 'Supervisor election');
  } catch (error) {
    if (error instanceof SlotBusyError) throw await lostTo(directory);
    throw error;
  }
  let epoch = 0;
  try {
    epoch = (await readJson<{ epoch: number }>(join(namespace, 'epoch.json'))).epoch;
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid supervisor epoch');
  epoch += 1;
  await writeDurable(join(namespace, 'epoch.json'), { epoch });
  return {
    epoch,
    owner,
    release: () =>
      release().catch((error: unknown) => {
        if (!(error instanceof ClaimReplacedError)) throw error;
      }),
  };
}
