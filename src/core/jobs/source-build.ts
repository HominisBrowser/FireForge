// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';

import type { AuthoredSnapshot } from '../authored/types.js';
import { runtimeRoute } from '../proof/route.js';
import type { SlotRecord } from './slot-types.js';

/**
 * Root inputs a compile reads: generated mozconfigs, and component sources unless
 * they already arrive as a generated tree. A linter's config or a project script
 * is captured for what runs against it and has no effect on the binary, and a
 * release overlay reaches only a release's own object directory.
 */
function buildReads(path: string, snapshot: AuthoredSnapshot): boolean {
  if (path === snapshot.config.build?.release?.overlay) return false;
  if (path.startsWith('configs/')) return true;
  return (
    snapshot.generatedTree === undefined &&
    (path === 'furnace.json' || path.startsWith('components/'))
  );
}

/** A full binary can survive UI-only changes; unknown, generator and packaging inputs cannot. */
export function compiledSourceDigest(snapshot: AuthoredSnapshot, recipe?: string): string {
  const fullRoute = (path: string): boolean =>
    ['compiled', 'unknown', 'packaged', 'component'].includes(runtimeRoute(path));
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        pin: snapshot.pin,
        recipe: recipe ?? null,
        config: {
          name: snapshot.config.name,
          vendor: snapshot.config.vendor,
          appId: snapshot.config.appId,
          binaryName: snapshot.config.binaryName,
          firefox: snapshot.config.firefox,
          license: snapshot.config.license,
          markerComment: snapshot.config.markerComment,
        },
        files: snapshot.files
          .filter((file) => fullRoute(file.path))
          .map((file) => ({ path: file.path, kind: file.kind, blob: file.blob, mode: file.mode }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        inputs: snapshot.inputs
          .filter((input) => buildReads(input.path, snapshot))
          .map((input) => ({ path: input.path, blob: input.blob, mode: input.mode }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      })
    )
    .digest('hex');
}

/** Only an authenticated actual full build establishes the anchor; source changes merely compare it. */
export function refreshFullBuildRequirement(slot: SlotRecord, snapshot: AuthoredSnapshot): void {
  slot.requiresFullBuild =
    slot.fullBuildAnchor?.digest !== compiledSourceDigest(snapshot, slot.buildRecipeDigest);
}
