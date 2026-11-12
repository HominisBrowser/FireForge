// SPDX-License-Identifier: EUPL-1.2
/**
 * Having a Firefox engine and building it: acquiring the pinned source as a
 * pristine repository, the workspaces commands build and test in, the host
 * locks, `mach`, builds and their staleness, and running and packaging the
 * browser.
 */

// The pin and the pristine repository
export { sourceArchive } from './archive.js';
export { pinKey } from './pin.js';
export {
  type EngineInstall,
  ensurePristine,
  findPristine,
  installProjectEngine,
  listPristineTree,
  type Pristine,
  readPristineFiles,
} from './pristine.js';

// Workspaces and the pool
export {
  addWorkspace,
  leaseWorkspace,
  listWorkspaces,
  type PoolWorkspace,
  removeWorkspace,
  repairWorkspace,
} from './pool.js';
export {
  engineLockPath,
  withEngineLock,
  withProjectWorkspace,
  type Workspace,
} from './workspace.js';

// Host configuration and locks
export { withDisplay } from './hostLocks.js';

// mach
export { runMach } from './mach.js';
export { withoutObjdir } from './mozconfig.js';

// Builds and staleness
export { bootstrap, build, ensureBuilt } from './build.js';
export { type BuildKind, readBuildBaseline } from './staleness.js';

// Running, packaging, watching
export { packageBrowser } from './package.js';
export { runBrowser } from './run.js';
export { watch } from './watch.js';
