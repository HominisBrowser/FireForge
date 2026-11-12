// SPDX-License-Identifier: EUPL-1.2
/**
 * A lint run's result: the findings that surfaced, those waivers dropped,
 * the standing of every waiver, and the one judgement of pass or fail.
 */
import type { JsonObject } from '../kernel/json.js';
import type { Finding, Severity } from './rule.js';
import type { WaiverStatus } from './waivers.js';

/** What {@link runLint} returns. */
export interface LintReport {
  /** Surfaced findings, sorted by group, path, line and rule. */
  readonly findings: readonly Finding[];
  /** Findings a group's lintIgnore dropped. */
  readonly suppressed: readonly Finding[];
  readonly waivers: readonly WaiverStatus[];
}

/** The judgement of a report. */
export interface LintVerdict {
  readonly pass: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly notices: number;
  /** Why it failed, for a verdict line or an error message. */
  readonly reason?: string;
}

function count(report: LintReport, severity: Severity): number {
  return report.findings.filter((finding) => finding.severity === severity).length;
}

/**
 * Judges a report: any error fails, and so do more warnings than
 * `maxWarnings` when it is given. Notices never fail.
 *
 * @param report - The report
 * @param maxWarnings - The most warnings a passing run may have
 */
export function lintVerdict(report: LintReport, maxWarnings?: number): LintVerdict {
  const errors = count(report, 'error');
  const warnings = count(report, 'warning');
  const notices = count(report, 'notice');
  const reason =
    errors > 0
      ? `${errors} error(s)`
      : maxWarnings !== undefined && warnings > maxWarnings
        ? `${warnings} warning(s), more than --max-warnings ${maxWarnings}`
        : undefined;
  return {
    pass: reason === undefined,
    errors,
    warnings,
    notices,
    ...(reason === undefined ? {} : { reason }),
  };
}

function findingJson(finding: Finding): JsonObject {
  return {
    rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    path: finding.path ?? null,
    line: finding.line ?? null,
    group: finding.group ?? null,
    ...(finding.measurement === undefined ? {} : { measurement: finding.measurement }),
    ...(finding.share === undefined ? {} : { share: finding.share }),
  };
}

/**
 * The `--json` document of a run.
 *
 * @param report - The report
 * @param verdict - Its judgement
 */
export function lintReportJson(report: LintReport, verdict: LintVerdict): JsonObject {
  return {
    pass: verdict.pass,
    errors: verdict.errors,
    warnings: verdict.warnings,
    notices: verdict.notices,
    findings: report.findings.map(findingJson),
    suppressed: report.suppressed.map(findingJson),
    waivers: report.waivers.map((waiver) => ({
      group: waiver.group,
      rule: waiver.rule,
      max: waiver.max,
      reason: waiver.reason,
      share: waiver.share ?? null,
      measurement: waiver.measurement,
      state: waiver.state,
    })),
  };
}

/**
 * Human lines for a report: findings under a heading per group (project-
 * level findings first), each `severity path:line [rule] message`. Notices
 * are summarised in one line per rule unless `verbose`.
 *
 * @param report - The report
 * @param verdict - Its judgement
 * @param verbose - Print every notice
 */
export function renderLintReport(
  report: LintReport,
  verdict: LintVerdict,
  verbose: boolean
): string[] {
  const shown = report.findings.filter((finding) => verbose || finding.severity !== 'notice');
  const lines: string[] = [];
  let heading: string | undefined;
  for (const finding of shown) {
    const group = finding.group ?? '(project)';
    if (group !== heading) {
      if (heading !== undefined) lines.push('');
      lines.push(group);
      heading = group;
    }
    const where =
      finding.path === undefined
        ? ''
        : `${finding.path}${finding.line === undefined ? '' : `:${finding.line}`} `;
    lines.push(`  ${finding.severity.padEnd(7)} ${where}[${finding.rule}] ${finding.message}`);
  }
  if (!verbose && verdict.notices > 0) {
    const byRule = new Map<string, number>();
    for (const finding of report.findings) {
      if (finding.severity === 'notice')
        byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
    }
    if (lines.length > 0) lines.push('');
    lines.push(
      `Notices (advisory; --verbose lists them): ${[...byRule].map(([rule, n]) => `${rule} ${n}`).join(', ')}`
    );
  }
  if (lines.length > 0) lines.push('');
  const suppressed = report.suppressed.length > 0 ? `, ${report.suppressed.length} waived` : '';
  lines.push(
    `Lint: ${verdict.errors} error(s), ${verdict.warnings} warning(s), ${verdict.notices} notice(s)${suppressed}` +
      (verdict.pass ? '' : ` — failed: ${verdict.reason ?? ''}`)
  );
  return lines;
}
