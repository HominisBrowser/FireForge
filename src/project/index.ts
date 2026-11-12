// SPDX-License-Identifier: EUPL-1.2
/**
 * The project context every command starts from: root discovery, the loaded
 * configuration and mode, every well-known location, the git checkout, the
 * project state document, and the owned-change model both modes produce.
 */
export {
  type ChangeGroup,
  type ChangeSet,
  type ContentReader,
  type CreateChange,
  createChangeSet,
  type FileMode,
  type LintIgnoreEntry,
  type ModifyChange,
  netChange,
  type OwnedChange,
  textContent,
} from './changes.js';
export { readCheckout } from './checkout.js';
export {
  type CommentStyle,
  hasLicenseHeader,
  hasUpstreamMplHeader,
  type License,
  licenseHeader,
  mentionsLicense,
} from './license.js';
export {
  configuredPath,
  type Environment,
  findProjectRoot,
  type HostPaths,
  hostPaths,
  loadProject,
  type PatchProject,
  type Project,
  type ProjectPaths,
  projectPaths,
  type SourceProject,
} from './project.js';
export { defineStateSection, readState, updateState } from './state.js';
export type { TrackedFiles } from './tracked.js';
