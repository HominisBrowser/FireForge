// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { digest } from '../authored/git.js';
import type { BuildIdentity, PhaseRuntimeIdentity, SlotRecord } from './slot-types.js';
import { readJson, slotDirectory } from './store.js';

export type { PhaseRuntimeIdentity } from './slot-types.js';

async function ledger<T>(path: string, empty: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return empty;
    throw error;
  }
}

/** The bytes the ledgers declare and nothing about who wrote them: a repeat of a generator changes nothing. */
async function derivedContentDigest(directory: string): Promise<string> {
  const derived = await ledger<Record<string, { sha256: string; mode: string }>>(
    join(directory, 'derived.json'),
    {}
  );
  const build = await ledger<{ files: Record<string, { sha256: string; mode: string }> }>(
    join(directory, 'build-derived.json'),
    { files: {} }
  );
  const content = (entries: Record<string, { sha256: string; mode: string }>): string[][] =>
    Object.entries(entries).map(([path, { sha256, mode }]) => [path, sha256, mode]);
  return digest({ derived: content(derived), build: content(build.files) });
}

/** What the slot's trusted package is a build of. Holds no path, generation or per-job value. */
function buildIdentity(slot: SlotRecord): BuildIdentity | undefined {
  const anchor = slot.fullBuildAnchor;
  if (slot.trustedBuild === undefined || anchor === undefined || slot.requiresFullBuild === true)
    return undefined;
  return {
    compiled: anchor.digest,
    ...(anchor.nativeToolsDigest === undefined ? {} : { native: anchor.nativeToolsDigest }),
    ...(slot.objdirToolsDigest === undefined ? {} : { toolchain: slot.objdirToolsDigest }),
  };
}

/** Cheap declared-ledger identity; final sealing still performs the full boundary audit. */
export async function phaseRuntimeIdentity(
  namespace: string,
  slot: SlotRecord
): Promise<PhaseRuntimeIdentity> {
  const directory = slotDirectory(namespace, slot.id);
  const materialization = await readFile(join(directory, 'materialization.json'));
  const build = buildIdentity(slot);
  return {
    sourceGeneration: slot.generation,
    successfulBuildGeneration: slot.successfulBuildGeneration,
    materializationDigest: createHash('sha256').update(materialization).digest('hex'),
    derivedDigest: await derivedContentDigest(directory),
    ...(slot.trustedBuild === undefined
      ? {}
      : { buildBaselineDigest: slot.trustedBuild.baselineDigest }),
    ...(build === undefined ? {} : { build }),
  };
}
