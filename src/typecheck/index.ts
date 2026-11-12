// SPDX-License-Identifier: EUPL-1.2
/**
 * Whole-project type checking: the configured jsconfig projects in the
 * workspace's engine, plus the strict typing of the owned files that `lint`
 * runs, as one result.
 */
export { explainTypecheck, explanationJson, renderExplanation } from './explain.js';
export {
  renderTypecheckReport,
  runTypecheck,
  type TypecheckReport,
  typecheckReportJson,
  type TypecheckRequest,
  typecheckVerdict,
} from './typecheck.js';
