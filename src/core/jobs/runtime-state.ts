// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { AuthoredSnapshot } from '../authored/types.js';
import { assertDependencyCachesCurrent } from './dependency-caches.js';
import type { JobRequest } from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { refreshFullBuildRequirement } from './source-build.js';
import { slotDirectory, writeDurable, writeDurableBytes } from './store.js';

/** The build recipe a request implies, which a compiled anchor binds. */
export function buildRecipeDigest(
  request: Pick<JobRequest, 'build'>,
  snapshot: AuthoredSnapshot
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        mode: request.build?.mode ?? 'dev',
        brand: request.build?.brand ?? snapshot.config.binaryName,
      })
    )
    .digest('hex');
}

/** Where a slot lists its captured root files, one per line, for `FIREFORGE_CAPTURED_FILES`. */
export const capturedFilesPath = (root: string): string =>
  join(root, '.fireforge', 'captured-files');

/** Runtime metadata is an explicit job input, never inherited from a previous slot user or donor. */
export async function seedRuntimeState(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot,
  request: JobRequest
): Promise<void> {
  await assertDependencyCachesCurrent(namespace, slot, snapshot);
  const recipe = {
    mode: request.build?.mode ?? 'dev',
    brand: request.build?.brand ?? snapshot.config.binaryName,
  };
  if (
    !['dev', 'debug', 'release'].includes(recipe.mode) ||
    recipe.brand !== snapshot.config.binaryName
  )
    throw new Error('Build metadata does not agree with captured configuration');
  const digest = buildRecipeDigest(request, snapshot);
  if (slot.buildRecipeDigest !== undefined && slot.buildRecipeDigest !== digest) {
    delete slot.trustedBuild;
    slot.requiresBuild ||= slot.successfulBuildGeneration > 0;
  }
  slot.buildRecipeDigest = digest;
  refreshFullBuildRequirement(slot, snapshot);
  await writeDurable(join(slot.root, '.fireforge', 'state.json'), {
    brand: recipe.brand,
    buildMode: recipe.mode,
    baseCommit: slot.pin,
    downloadedVersion: snapshot.config.firefox.version,
  });
  // A slot has no repository, and a project check that asks what is tracked reads this instead.
  await writeDurableBytes(
    capturedFilesPath(slot.root),
    snapshot.inputs.map((input) => `${input.path}\n`).join('')
  );
  await writeDurable(join(slotDirectory(namespace, slot.id), 'slot.json'), slot);
}
