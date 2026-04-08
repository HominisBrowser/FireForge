// SPDX-License-Identifier: EUPL-1.2
/**
 * Patches manifest — re-exports from focused sub-modules.
 *
 * Callers should continue to import from this module; the internal split
 * is an implementation detail.
 */

export type { PatchManifestConsistencyIssue } from './patch-manifest-consistency.js';
export {
  rebuildPatchesManifest,
  validatePatchesManifestConsistency,
} from './patch-manifest-consistency.js';
export {
  addPatchToManifest,
  loadPatchesManifest,
  PATCHES_MANIFEST,
  savePatchesManifest,
} from './patch-manifest-io.js';
export {
  checkVersionCompatibility,
  findPatchesAffectingFile,
  getClaimedFiles,
  stampPatchVersions,
  validatePatchIntegrity,
} from './patch-manifest-query.js';
export { validatePatchesManifest } from './patch-manifest-validate.js';
