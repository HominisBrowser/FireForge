// SPDX-License-Identifier: EUPL-1.2
/**
 * Processes: running programs, identifying them exactly, listing them, and
 * owning the tree a program starts.
 */
export {
  isIdentityAlive,
  isProcessAlive,
  isProcessGroupAlive,
  listProcesses,
  ownIdentity,
  processHasExited,
  type ProcessIdentity,
  processIdentity,
  snapshotProcesses,
  terminateByIdentity,
} from './identity.js';
export { commandNamesRoot } from './listing.js';
export { findExecutable, onProcessGroup, run, runBytes } from './spawn.js';
