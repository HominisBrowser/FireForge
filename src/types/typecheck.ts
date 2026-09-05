// SPDX-License-Identifier: EUPL-1.2
/**
 * Types for the `fireforge typecheck` command.
 *
 * Kept separate from `PatchLintIssue` because the two flows model
 * different things: patch-lint issues are keyed on a stable `check`
 * rule ID (consumed by `lintIgnore`, severity gates, and the
 * cross-patch tagger), while typecheck issues carry a raw TypeScript
 * diagnostic code that should never enter the patch-lint vocabulary.
 * Conflating them would let `lintIgnore` accidentally suppress TS
 * errors and would force `PatchLintIssue` to grow line / column /
 * code fields that have no meaning for patch-hygiene rules.
 */

/**
 * A single diagnostic produced by `runTypecheck` for one source file.
 */
export interface TypecheckIssue {
  /** Absolute path to the source file the diagnostic originated in. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Raw TypeScript diagnostic code (e.g. 2322 for a type mismatch). */
  code: number;
  /**
   * Severity bucket. TS also reports `Suggestion` and `Message`
   * categories, but `runTypecheck` collapses both into `'warning'` so
   * the CLI has only two visible levels.
   */
  category: 'error' | 'warning';
  /** Human-readable message text (already flattened from chains). */
  message: string;
  /**
   * Project-relative path of the originating jsconfig.json. Useful
   * when typecheck.projects names multiple projects and the operator
   * needs to know which one fired.
   */
  project: string;
}

/**
 * Per-project typecheck output. One entry per `typecheck.projects`
 * jsconfig path, in the order the projects were declared.
 */
export interface TypecheckProjectResult {
  /** Project-relative path of the jsconfig.json. */
  project: string;
  /** All issues from this project (errors + warnings). */
  issues: TypecheckIssue[];
  /** How many root files the program was built against (excludes the synthetic shim). */
  filesChecked: number;
}
