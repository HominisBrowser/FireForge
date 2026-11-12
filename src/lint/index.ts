// SPDX-License-Identifier: EUPL-1.2
/**
 * Quality rules over the owned changes: content, size, license, build
 * registration, policy and strict typing, with per-group waivers and one
 * report. Every rule reads a `ChangeSet` and an `EngineReader`; none asks
 * which mode produced them.
 *
 * The TypeScript toolkit (loading the compiler API, the Firefox-globals
 * shim, which diagnostics count) is exported for `typecheck`, so both type
 * passes judge code the same way.
 */
export type { OwnedTypesView } from './checkjs.js';
export { type LintReport, lintReportJson, lintVerdict, renderLintReport } from './report.js';
export type { EngineReader, Finding, Severity, TokenPolicy } from './rule.js';
export { checkOwnedTypes, explainOwnedTypes, RULES, runLint } from './run.js';
export {
  composeShim,
  judgeDiagnostic,
  loadTypeScript,
  type Shim,
  type TypeScript,
  withGeckoDomTypes,
} from './typescript.js';
