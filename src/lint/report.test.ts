// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { type LintReport, lintReportJson, lintVerdict, renderLintReport } from './report.js';
import type { Finding } from './rule.js';

const finding = (severity: Finding['severity'], overrides: Partial<Finding> = {}): Finding => ({
  rule: 'jsdoc',
  severity,
  message: `A ${severity}.`,
  ...overrides,
});

const report = (findings: Finding[], suppressed: Finding[] = []): LintReport => ({
  findings,
  suppressed,
  waivers: [],
});

describe('lintVerdict', () => {
  it.each([
    [[], undefined, true, undefined],
    [[finding('notice'), finding('notice')], 0, true, undefined],
    [[finding('warning')], undefined, true, undefined],
    [[finding('warning')], 1, true, undefined],
    [
      [finding('warning'), finding('warning')],
      1,
      false,
      '2 warning(s), more than --max-warnings 1',
    ],
    [[finding('error'), finding('warning')], 5, false, '1 error(s)'],
  ] as const)('%j under max %s passes: %s', (findings, max, pass, reason) => {
    const verdict = lintVerdict(report([...findings]), max);
    expect(verdict.pass).toBe(pass);
    expect(verdict.reason).toBe(reason);
  });
});

describe('renderLintReport', () => {
  const sample = report(
    [
      finding('error', { message: 'Project-wide.' }),
      finding('warning', { group: 'g', path: 'browser/a.js', line: 3, rule: 'relative-import' }),
      finding('notice', { group: 'g', path: 'browser/a.js', rule: 'file-too-large' }),
      finding('notice', { group: 'h', rule: 'file-too-large' }),
    ],
    [finding('warning')]
  );

  it('groups findings under headings, summarises notices, and ends with the totals', () => {
    expect(renderLintReport(sample, lintVerdict(sample), false)).toEqual([
      '(project)',
      '  error   [jsdoc] Project-wide.',
      '',
      'g',
      '  warning browser/a.js:3 [relative-import] A warning.',
      '',
      'Notices (advisory; --verbose lists them): file-too-large 2',
      '',
      'Lint: 1 error(s), 1 warning(s), 2 notice(s), 1 waived — failed: 1 error(s)',
    ]);
  });

  it('lists every notice when verbose, and prints only the totals for an empty report', () => {
    const lines = renderLintReport(sample, lintVerdict(sample), true);
    expect(lines).toContain('  notice  browser/a.js [file-too-large] A notice.');
    expect(lines).toContain('h');
    expect(lines.some((line) => line.startsWith('Notices'))).toBe(false);
    expect(renderLintReport(report([]), lintVerdict(report([])), false)).toEqual([
      'Lint: 0 error(s), 0 warning(s), 0 notice(s)',
    ]);
  });
});

describe('lintReportJson', () => {
  it('writes counts, findings with nulls for absent fields, and waivers', () => {
    const value = report([finding('warning', { measurement: 12, share: 'test' })]);
    const withWaiver: LintReport = {
      ...value,
      waivers: [
        {
          group: 'g',
          rule: 'jsdoc',
          max: null,
          reason: null,
          measurement: null,
          state: 'removable',
        },
      ],
    };
    expect(lintReportJson(withWaiver, lintVerdict(withWaiver))).toEqual({
      pass: true,
      errors: 0,
      warnings: 1,
      notices: 0,
      findings: [
        {
          rule: 'jsdoc',
          severity: 'warning',
          message: 'A warning.',
          path: null,
          line: null,
          group: null,
          measurement: 12,
          share: 'test',
        },
      ],
      suppressed: [],
      waivers: [
        {
          group: 'g',
          rule: 'jsdoc',
          max: null,
          reason: null,
          share: null,
          measurement: null,
          state: 'removable',
        },
      ],
    });
  });
});
