// SPDX-License-Identifier: EUPL-1.2
/**
 * Git, for the whole tool. Nothing else runs git.
 *
 * Every function takes the repository's directory first (its top level, or
 * a bare repository's directory) and runs git hermetically: host and user
 * configuration are ignored, output-affecting settings are pinned,
 * pathspecs are literal, parent directories are never searched, and reading
 * never writes the index (`run.ts`). Paths are repository-relative with
 * forward slashes. Failures are `FireForgeError`s with exit code
 * `GIT_ERROR` and codes `git-failed`, `git-not-a-repository`,
 * `git-index-locked`, `git-path-encoding` and `git-invalid-spec`, git's
 * stderr in the message and the cause.
 *
 * Operations that build something without touching the user's state
 * (trees, snapshots, dry-run applies, diffs of a working tree) use a private
 * index; {@link withPrivateIndex} is the same tool for a caller's own
 * sequence of plumbing.
 */

// Running git
export { git, gitBytes, gitResult, withPrivateIndex } from './run.js';

// Repositories, revisions, configuration, worktrees
export {
  cloneRepository,
  currentBranch,
  fetchCommit,
  getConfig,
  gitDir,
  initRepository,
  isAncestor,
  isRepository,
  listWorktrees,
  mergeBase,
  objectFormat,
  resolveRevision,
  setConfig,
} from './repo.js';

// The working tree
export {
  checkAttributes,
  checkIgnore,
  cleanPaths,
  isTracked,
  listFiles,
  reset,
  restorePaths,
  status,
} from './status.js';

// Objects
export {
  captureWorktree,
  commitTree,
  emptyTree,
  listTree,
  readBlobs,
  type TreeEntry,
  writeBlobs,
  writeTree,
} from './objects.js';

// Refs and recovery snapshots
export { listRefs, RECOVERY_REF_PREFIX, saveRecoverySnapshot, updateRef } from './refs.js';

// Patch bodies
export { changedPaths, diffTrees, diffWorktree } from './diff.js';

// Applying and merging
export { apply, type ApplyConflict, mergeFile } from './apply.js';
