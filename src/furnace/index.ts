// SPDX-License-Identifier: EUPL-1.2
/**
 * Furnace: the fork's UI components. Their sources live in the project
 * (`components/`, described by `furnace.json`); Furnace deploys them into an
 * engine it is given, validates them, scaffolds and renames them, and
 * generates the typing files that make them typed for their users.
 *
 * Furnace never asks which mode a project is in. Deployment takes the
 * engine to deploy into ({@link FurnaceWorkspace}); edits of engine files
 * the project tracks go through the caller's `TrackedFiles`.
 */
export { componentHostFiles, type FurnaceProject, loadFurnaceConfig } from './config.js';
export {
  applyComponents,
  type ApplyOptions,
  componentFiles,
  type DeploymentResult,
  deploymentStatus,
  type FurnaceWorkspace,
} from './deploy.js';
export { componentDiff } from './diff.js';
export { type EditResult } from './edit.js';
export {
  createComponent,
  overrideComponent,
  removeComponent,
  renameComponent,
  updateTypingFiles,
} from './operations.js';
export { TEST_STYLES } from './scaffold.js';
export { typingDrift } from './typing.js';
export { validateComponents, validationPasses, type ValidationReport } from './validate.js';
