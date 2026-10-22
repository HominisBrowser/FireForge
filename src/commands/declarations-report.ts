// SPDX-License-Identifier: EUPL-1.2
/**
 * One `--from`-ready declaration report for a refused queue change.
 *
 * Moving a test out of a patch that owns a shared manifest refuses with one
 * `forward-registration` error per manifest line, and each line would need
 * its own `patch staged-dependency --add` call. `patch move-files`,
 * `patch split` and `re-export --scan` write every declaration their refusal
 * proposes into one lint-report-shaped JSON (`queueIssues[].stagedDeclarations`) and
 * name the single `patch staged-dependency <holder> --add --from <file>`
 * call per holding patch that discharges them.
 */
import { join, resolve } from 'node:path';

import type { ConflictReport } from '../core/destructive.js';
import { STAGED_DEPENDENCY_REASON_PLACEHOLDER } from '../core/patch-lint-staged-registration.js';
import type { PatchLintIssue, PatchLintStagedDeclaration } from '../types/commands/index.js';
import { ensureDir, writeJson } from '../utils/fs.js';

/** Where an unnamed report goes, relative to the project root. */
const DEFAULT_REPORT_DIR = join('.fireforge', 'declarations');

/** The checks whose findings carry declarations that discharge them. */
const DECLARABLE_CHECKS = new Set(['forward-import', 'forward-registration']);

/** A written declaration report and the commands that apply it. */
export interface DeclarationsReport {
  /** Absolute path of the JSON report. */
  path: string;
  /** Declarations written. */
  count: number;
  /** One `patch staged-dependency <holder> --add --from` call per holder. */
  commands: string[];
}

/**
 * A declaration as the report records it. `owner` is optional for renamers
 * that cannot name one; `reason` is the rationale `staged-dependency --add
 * --from` records with the declaration (an entry's own reason wins over the
 * call's `--reason`).
 */
export type ReportedDeclaration = Omit<PatchLintStagedDeclaration, 'owner'> & {
  owner?: string;
  reason?: string;
};

/** Rewrites a projected declaration into the names the current queue uses. */
export type DeclarationRenamer = (declaration: PatchLintStagedDeclaration) => ReportedDeclaration;

/**
 * Writes every declaration `issues` propose into one report, or returns
 * undefined when they propose none.
 *
 * @param projectRoot - Project root (the default report directory lives under it)
 * @param issues - The refusal's findings
 * @param out - `--declarations-out`, relative to the working directory
 * @param rename - Maps projected patch names back to current ones
 * @param reason - Rationale stamped on every declaration that carries none
 *   (`patch move-files` and `patch split` name the move that needs it)
 */
export async function writeDeclarationsReport(
  projectRoot: string,
  issues: readonly PatchLintIssue[],
  out?: string,
  rename: DeclarationRenamer = (declaration) => declaration,
  reason?: string
): Promise<DeclarationsReport | undefined> {
  const withReason = (declaration: ReportedDeclaration): ReportedDeclaration =>
    reason === undefined || declaration.reason !== undefined
      ? declaration
      : { ...declaration, reason };
  const queueIssues = issues
    .filter((issue) => DECLARABLE_CHECKS.has(issue.check))
    .map((issue) => ({
      check: issue.check,
      file: issue.file,
      message: issue.message,
      stagedDeclarations: (issue.stagedDeclarations ?? []).map((declaration) =>
        withReason(rename(declaration))
      ),
    }))
    .filter((issue) => issue.stagedDeclarations.length > 0);
  const declarations = queueIssues.flatMap((issue) => issue.stagedDeclarations);
  if (declarations.length === 0) return undefined;

  const path =
    out !== undefined
      ? resolve(out)
      : join(
          projectRoot,
          DEFAULT_REPORT_DIR,
          `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`
        );
  await ensureDir(resolve(path, '..'));
  await writeJson(path, { queueIssues });
  const holders = [...new Set(declarations.map((declaration) => declaration.patch))].sort();
  // A report whose every entry carries its reason needs no `--reason`.
  const reasonFlag = declarations.every((declaration) => declaration.reason !== undefined)
    ? ''
    : ` ${STAGED_DEPENDENCY_REASON_PLACEHOLDER}`;
  return {
    path,
    count: declarations.length,
    commands: holders.map(
      (holder) => `fireforge patch staged-dependency ${holder} --add --from ${path}${reasonFlag}`
    ),
  };
}

/** The refusal lines that point at a written report. */
export function formatDeclarationsReport(report: DeclarationsReport): string[] {
  return [
    `All ${report.count} declaration(s) this refusal proposes are in ${report.path}; ` +
      'declare them in one call per holding patch:',
    ...report.commands.map((command) => `  ${command}`),
  ];
}

/**
 * Appends the report lines to a refusal, writing the report from the
 * refusal's findings. A refusal that proposes no declaration is returned
 * unchanged, and so is no refusal at all.
 */
export async function withDeclarationsReport(
  conflicts: ConflictReport | null,
  args: {
    projectRoot: string;
    regressions: readonly PatchLintIssue[];
    out?: string | undefined;
    rename?: DeclarationRenamer;
    reason?: string;
  }
): Promise<ConflictReport | null> {
  if (conflicts === null) return null;
  const report = await writeDeclarationsReport(
    args.projectRoot,
    args.regressions,
    args.out,
    args.rename,
    args.reason
  );
  if (report === undefined) return conflicts;
  return { ...conflicts, details: [...conflicts.details, ...formatDeclarationsReport(report)] };
}
