// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { LINT_RULE_IDS } from '../config/index.js';
import type { ChangeGroup, LintIgnoreEntry } from '../project/index.js';
import { engineFiles, textChangeSet, type TextStep } from '../testing/changes.js';
import { testConfig } from '../testing/config.js';
import { lintReport } from '../testing/lint.js';
import {
  type Finding,
  type LintReport,
  lintReportJson,
  lintVerdict,
  renderLintReport,
  RULES,
  runLint,
  type Severity,
} from './index.js';

const big = (group: string, count: number): TextStep[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `browser/app/${group}${i}.js`,
    group,
    after: 'x();\n',
  }));

function group(id: string, lintIgnore: LintIgnoreEntry[]): ChangeGroup {
  return { id, meta: {}, lintIgnore };
}

describe('the rule registry', () => {
  it('holds every configurable rule ID once', () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids, 'lint-ignore-removable'].sort()).toEqual([...LINT_RULE_IDS].sort());
  });
});

describe('waivers', () => {
  const lint = (lintIgnore: LintIgnoreEntry[], files = 7): Promise<LintReport> =>
    lintReport(big('g', files), { groups: [group('g', lintIgnore)] });

  it('drops every finding of a bare rule ID', async () => {
    const report = await lint(['large-patch-files']);
    expect(report.findings.filter((f) => f.rule === 'large-patch-files')).toEqual([]);
    expect(report.suppressed.map((f) => f.rule)).toContain('large-patch-files');
    expect(report.waivers).toMatchObject([
      { rule: 'large-patch-files', max: null, measurement: 7, state: 'within' },
    ]);
  });

  it('drops a measured finding only up to the ceiling, and names the ceiling past it', async () => {
    const ceiling = { rule: 'large-patch-files', max: 7, reason: 'one set' };
    expect((await lint([ceiling])).findings.filter((f) => f.rule === 'large-patch-files')).toEqual(
      []
    );
    const over = await lint([ceiling], 8);
    const surfaced = over.findings.filter((f) => f.rule === 'large-patch-files');
    expect(surfaced.map((f) => f.message.endsWith('(max 7: one set).'))).toEqual([true]);
    expect(over.waivers).toMatchObject([{ state: 'exceeded', measurement: 8 }]);
  });

  it('offers a removable notice for a ceiling the rule no longer needs', async () => {
    const report = await lint([{ rule: 'large-patch-files', max: 9, reason: 'r' }], 3);
    expect(report.waivers).toMatchObject([{ state: 'removable', measurement: null }]);
    expect(
      report.findings.filter((f) => f.rule === 'lint-ignore-removable').map((f) => f.severity)
    ).toEqual(['notice']);
  });

  it('bounds a share-scoped ceiling to its share', async () => {
    const steps = [
      { path: 'browser/A.sys.mjs', group: 'g', after: 'x();\n'.repeat(1600) },
      { path: 'browser/test/browser_a.js', group: 'g', after: 'x();\n'.repeat(3200) },
    ];
    const lintIgnore = [
      { rule: 'large-patch-lines', max: 1600, reason: 'r', share: 'product' as const },
    ];
    const report = await lintReport(steps, {
      groups: [group('g', lintIgnore)],
      config: { patchLint: { patchSizeMetric: 'addedCode' } },
    });
    expect(
      report.findings
        .filter((f) => f.rule === 'large-patch-lines')
        .map((f) => [f.share, f.severity])
    ).toEqual([['test', 'warning']]);
  });

  it('judges a path finding by every group with a step on the path', async () => {
    const steps = [
      { path: 'browser/a.mjs', group: 'one', after: 'import "./x.mjs";\n' },
      {
        path: 'browser/a.mjs',
        group: 'two',
        before: 'import "./x.mjs";\n',
        after: 'import "./y.mjs";\n',
      },
    ];
    const report = await lintReport(steps, {
      groups: [group('one', []), group('two', ['relative-import'])],
    });
    expect(report.findings.filter((f) => f.rule === 'relative-import')).toEqual([]);
  });
});

describe('configured severities and the report', () => {
  it('replaces a rule severity, or turns the rule off', async () => {
    const steps = [{ path: 'browser/a.mjs', after: 'import "./x.mjs";\n' }];
    const loud = await lintReport(steps, {
      config: { patchLint: { rules: { 'relative-import': 'warning' } } },
    });
    expect(loud.findings.find((f) => f.rule === 'relative-import')?.severity).toBe('warning');
    const off = await lintReport(steps, {
      config: { patchLint: { rules: { 'relative-import': 'off' } } },
    });
    expect(off.findings.find((f) => f.rule === 'relative-import')).toBeUndefined();
  });

  it('keeps group findings when paths narrow the run, and drops findings elsewhere', async () => {
    const steps = [
      ...big('g', 6),
      { path: 'other/a.mjs', group: 'g', after: 'import "./x.mjs";\n' },
    ];
    const report = await lintReport(steps, { groups: ['g'], paths: ['browser/app/'] });
    expect([...new Set(report.findings.map((f) => f.rule))].sort()).toEqual([
      'large-patch-files',
      'missing-license-header',
    ]);
  });

  it('fails on errors, on warnings past --max-warnings, never on notices', () => {
    const finding = (severity: Severity): Finding => ({
      rule: 'r',
      severity,
      message: 'm',
    });
    const report = (severities: Severity[]): LintReport => ({
      findings: severities.map(finding),
      suppressed: [],
      waivers: [],
    });
    expect(lintVerdict(report(['notice', 'warning'])).pass).toBe(true);
    expect(lintVerdict(report(['warning']), 0)).toMatchObject({
      pass: false,
      reason: '1 warning(s), more than --max-warnings 0',
    });
    expect(lintVerdict(report(['error']), 5)).toMatchObject({ pass: false, reason: '1 error(s)' });
  });

  it('renders findings under their group with notices summarised, and a JSON document', async () => {
    const report = await lintReport(
      [...big('g', 6), { path: 'browser/A.sys.mjs', after: 'x();\n'.repeat(501) }],
      {
        groups: ['g'],
        config: { license: 'EUPL-1.2', patchLint: { rules: { 'missing-license-header': 'off' } } },
      }
    );
    const verdict = lintVerdict(report, 0);
    expect(renderLintReport(report, verdict, false)).toEqual([
      'g',
      expect.stringMatching(/^ {2}warning \[large-patch-files\] Group touches 6 files/) as string,
      '',
      'Notices (advisory; --verbose lists them): file-too-large 1',
      '',
      'Lint: 0 error(s), 1 warning(s), 1 notice(s) — failed: 1 warning(s), more than --max-warnings 0',
    ]);
    expect(renderLintReport(report, verdict, true)[0]).toBe('(project)');
    expect(lintReportJson(report, verdict)).toMatchObject({
      pass: false,
      warnings: 1,
      findings: [
        { rule: 'file-too-large', path: 'browser/A.sys.mjs', group: null },
        { rule: 'large-patch-files', group: 'g', measurement: 6 },
      ],
    });
  });
});

describe('component files', () => {
  it('leaves the content rules Furnace runs on component sources to Furnace', async () => {
    const steps: TextStep[] = [
      { path: 'toolkit/content/widgets/moz-x/moz-x.css', after: ':host { color: #fff; }\n' },
      { path: 'toolkit/content/widgets/moz-x/moz-x.mjs', after: 'import "./a.mjs";\n' },
      { path: 'browser/themes/own.css', after: ':root { color: #fff; }\n' },
    ];
    const report = await runLint(textChangeSet(steps), engineFiles({}), testConfig(), {
      projectRoot: '/nonexistent-project',
      components: [
        'toolkit/content/widgets/moz-x/moz-x.css',
        'toolkit/content/widgets/moz-x/moz-x.mjs',
      ],
    });
    expect(
      report.findings
        .filter((finding) => ['raw-color-value', 'relative-import'].includes(finding.rule))
        .map((finding) => finding.path)
    ).toEqual(['browser/themes/own.css']);
  });
});
