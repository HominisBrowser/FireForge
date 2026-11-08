// SPDX-License-Identifier: EUPL-1.2
export { composeCapturedBuildOutputs } from './build-generated.js';
export { captureAuthoredSnapshot } from './capture.js';
export { generateAuthoredDelta } from './generate.js';
export { readSourceBlobs } from './git.js';
export {
  exportCapturedTree,
  exportPristineTree,
  materializeAuthoredSnapshot,
  recordAuthoredDerivedOutputs,
} from './materialize.js';
export { migrateLegacyQueue } from './migrate.js';
export { authenticateAuthoredSnapshot } from './provider.js';
export { refreshAuthoredSnapshot } from './refresh.js';
export * from './types.js';
export { declareAuthoredOverride, removeAuthoredOverride } from './writer.js';
