// SPDX-License-Identifier: EUPL-1.2
/**
 * Spawned-CLI pins for `fireforge check`: the verdict line is the last
 * stdout line, `--json` writes exactly one document, the exit code follows
 * the verdict, and built-in steps really run as child `fireforge`
 * processes (the `status` step here reads a real engine).
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runFireforgeCli,
  writeFiles,
  writeFireForgeConfig,
} from '../test-utils/index.js';

interface CheckJson {
  schemaVersion: number;
  verdict: string;
  reason?: string;
  summary: { steps: number; passed: number; failed: number; skipped: number };
  steps: {
    name: string;
    kind: string;
    status: string;
    exitCode: number | null;
    detail: string;
    timedOut?: boolean;
    outputTail?: string;
  }[];
}

describe('fireforge check across the process boundary', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-check-');
    await writeFireForgeConfig(projectRoot, {
      check: {
        extraSteps: [
          { name: 'audit-ok', command: 'echo audit fine' },
          { name: 'audit-red', command: 'echo first; echo "policy: 2 findings" >&2; exit 3' },
          { name: 'audit-slow', command: 'sleep 5', timeout: 1 },
          { name: 'audit-sub', command: 'pwd', cwd: 'tools' },
        ],
      },
    });
    await writeFiles(projectRoot, { 'tools/.keep': '' });
    await initCommittedRepo(join(projectRoot, 'engine'), { 'a.js': 'one\n' });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('passes with a PASS verdict line as the last stdout line', async () => {
    const result = await runFireforgeCli(projectRoot, ['check', '--only', 'status,audit-ok']);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('FIREFORGE-VERDICT: PASS steps=2 skipped=0');
    expect(result.stdout).toContain('0 changed file(s), none failing');
  }, 60_000);

  it('fails with a step table, the failing output tail, and exit 1', async () => {
    const result = await runFireforgeCli(projectRoot, ['check', '--only', 'audit-ok,audit-red']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=step-failures failed=audit-red steps=2 skipped=0'
    );
    expect(result.stdout).toContain('policy: 2 findings');
    expect(result.stderr).toContain('fireforge check failed: audit-red');
  }, 60_000);

  it('writes one JSON document under --json, timing out a slow step', async () => {
    await writeFiles(projectRoot, { 'engine/b.js': 'untracked\n' });
    const result = await runFireforgeCli(projectRoot, [
      'check',
      '--json',
      '--skip',
      'verify,lint,typecheck,furnace-validate,token-coverage,audit-red',
    ]);
    expect(result.exitCode).toBe(1);
    const doc = JSON.parse(result.stdout) as CheckJson;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.verdict).toBe('fail');
    expect(doc.reason).toBe('step-failures');
    const byName = new Map(doc.steps.map((step) => [step.name, step]));
    expect(byName.get('status')).toMatchObject({ status: 'fail', detail: '1 unmanaged' });
    expect(byName.get('audit-ok')).toMatchObject({ status: 'pass', exitCode: 0 });
    expect(byName.get('audit-slow')).toMatchObject({
      status: 'fail',
      timedOut: true,
      detail: 'timed out after 1s',
    });
    expect(byName.get('audit-sub')).toMatchObject({ status: 'pass' });
    expect(doc.summary).toEqual({ steps: 4, passed: 2, failed: 2, skipped: 0 });
  }, 60_000);

  it('refuses an unknown step name with exit 8 and an error envelope', async () => {
    const result = await runFireforgeCli(projectRoot, ['check', '--json', '--only', 'nope']);
    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, code: 'invalid-argument' });
  }, 60_000);
});
