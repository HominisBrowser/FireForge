// SPDX-License-Identifier: EUPL-1.2
/**
 * Public re-exports for {@link ./patch-lint.ts}. Split out so the
 * orchestrator stays within the ESLint `max-lines` budget.
 */

export {
  buildPatchQueueContext,
  collectForwardImportEdges,
  collectNewFileCreatorsByPath,
  extractImportSpecifiers,
  extractImportSpecifiersWithLines,
  findForwardImportIgnoreLines,
  FORWARD_IMPORT_IGNORE_MARKER,
  isForwardImportableFile,
  lintPatchQueue,
  lintPatchQueueDuplicateCreations,
  lintPatchQueueForwardImports,
  type PatchQueueContext,
  type PatchQueueEntry,
} from './patch-lint-cross.js';
export { buildModifiedFileAdditionsFromDiff, detectNewFilesInDiff } from './patch-lint-diff.js';
export { lintPatchQueueModuleRegistrations } from './patch-lint-module-registration.js';
