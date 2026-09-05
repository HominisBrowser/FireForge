// SPDX-License-Identifier: EUPL-1.2
/**
 * Patches manifest: re-exports from focused sub-modules.
 *
 * Callers should continue to import from this module. The internal split
 * is an implementation detail.
 */

export {
  type PatchManifestConsistencyIssue,
  rebuildPatchesManifest,
  recommendManifestRepair,
  validatePatchesManifestConsistency,
} from './patch-manifest-consistency.js';
export {
  type FilesAffectedRepair,
  repairPatchesFilesAffected,
} from './patch-manifest-files-affected.js';
export {
  addPatchToManifest,
  loadPatchesManifest,
  loadPatchesManifestForWrite,
  mutatePatchRowsInManifest,
  PATCHES_MANIFEST,
  type PatchRenameEntry,
  removePatchFileAndManifest,
  renumberPatchesInManifest,
  rewriteStagedDependencyOwners,
  savePatchesManifest,
} from './patch-manifest-io.js';
export {
  checkVersionCompatibility,
  findPatchesAffectingFile,
  getClaimedFiles,
  stampPatchVersions,
  validatePatchIntegrity,
} from './patch-manifest-query.js';
export { resolvePatchIdentifier } from './patch-manifest-resolve.js';
export { validatePatchesManifest } from './patch-manifest-validate.js';
