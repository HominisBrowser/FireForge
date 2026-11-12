// SPDX-License-Identifier: EUPL-1.2
/**
 * Test runs: resolving what to run, keeping the host clean around the
 * harness, running mach's test harnesses in a workspace, judging their
 * output into a verdict that a crash, a hang or a cut-off suite cannot fake,
 * and negative controls that prove the tests catch what they claim to.
 */
export { runControl } from './control.js';
export { envAssignments, planTests } from './plan.js';
export { runTests, validatorEnvironment } from './run.js';
export {
  controlReport,
  refusalLines,
  refusalVerdict,
  runReport,
  type TestReport,
  writeResults,
} from './verdict.js';
