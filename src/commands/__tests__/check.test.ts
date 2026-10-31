// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nativePath } from '../../test-utils/index.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../../utils/process.js', () => ({
  execStream: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({ patches: '/project/patches' })),
  loadConfig: vi.fn(),
}));

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(() => Promise.resolve(null)),
}));

import { loadConfig } from '../../core/config.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { ExecTimeoutError } from '../../errors/base.js';
import { DEFAULT_CONFIG } from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { note, setMachineOutputMode, setStdoutSealed } from '../../utils/logger.js';
import { execStream } from '../../utils/process.js';
import { checkCommand, parseCheckJobs, selectCheckSteps } from '../check.js';
import { formatCheckTable, formatCheckVerdictLine, judgeCheck } from '../check-report.js';
import type { CheckStepResult } from '../check-run.js';
import { runCheckSteps } from '../check-run.js';
import {
  buildCheckPlan,
  type CheckStepPlan,
  lastOutputLine,
  statusPolicyArgs,
  summarizeFurnace,
  summarizeStatus,
  summarizeTokenCoverage,
} from '../check-steps.js';

type StreamOptions = NonNullable<Parameters<typeof execStream>[2]>;

/** Scripts the child for a step: what it prints and how it exits. */
function scriptChildren(
  byStep: Record<string, { stdout?: string; stderr?: string; exitCode?: number; error?: Error }>
): void {
  vi.mocked(execStream).mockImplementation((command, args, options?: StreamOptions) => {
    const line = [command, ...args].join(' ');
    const key = Object.keys(byStep).find((name) => line.includes(name));
    const script = key === undefined ? {} : (byStep[key] ?? {});
    if (script.error) return Promise.reject(script.error);
    if (script.stdout) options?.onStdout?.(script.stdout);
    if (script.stderr) options?.onStderr?.(script.stderr);
    return Promise.resolve(script.exitCode ?? 0);
  });
}

function withConfig(overrides: Partial<FireForgeConfig> = {}): FireForgeConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  vi.mocked(loadConfig).mockResolvedValue(config);
  return config;
}

function result(overrides: Partial<CheckStepResult>): CheckStepResult {
  return {
    name: 'status',
    kind: 'builtin',
    command: 'fireforge status',
    status: 'pass',
    exitCode: 0,
    durationMs: 10,
    detail: '',
    ...overrides,
  };
}

function capture(): { text: () => string; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return {
    text: () => writes.join(''),
    restore: () => {
      spy.mockRestore();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  withConfig();
});

describe('buildCheckPlan', () => {
  it('bounds built-in steps by check.timeout and check.timeouts', () => {
    const plan = buildCheckPlan({
      projectRoot: '/project',
      config: { ...DEFAULT_CONFIG, check: { timeout: 600, timeouts: { lint: 30 } } },
      furnaceConfigured: true,
    });
    expect(plan.find((step) => step.name === 'lint')?.timeoutMs).toBe(30_000);
    expect(plan.find((step) => step.name === 'verify')?.timeoutMs).toBe(600_000);
  });

  it('orders extra steps by after and hands them the lint report', () => {
    const plan = buildCheckPlan({
      projectRoot: '/project',
      config: {
        ...DEFAULT_CONFIG,
        check: {
          lintReport: '.fireforge/check/lint.json',
          extraSteps: [{ name: 'policy', command: 'npm run policy', after: ['lint'] }],
        },
      },
      furnaceConfigured: false,
    });
    const lint = plan.find((step) => step.name === 'lint');
    expect(lint?.args.slice(-2)).toEqual([
      '--report',
      nativePath('/project/.fireforge/check/lint.json'),
    ]);
    const policy = plan.find((step) => step.name === 'policy');
    expect(policy?.after).toEqual(['lint']);
    expect(policy?.env).toEqual({
      FIREFORGE_CHECK_LINT_REPORT: nativePath('/project/.fireforge/check/lint.json'),
    });
  });

  it('marks check.skip skips as decisions and missing blocks as gaps', () => {
    const plan = buildCheckPlan({
      projectRoot: '/project',
      config: { ...DEFAULT_CONFIG, check: { skip: ['token-coverage'] } },
      furnaceConfigured: false,
    });
    expect(plan.find((step) => step.name === 'token-coverage')?.skipKind).toBe('config');
    expect(plan.find((step) => step.name === 'typecheck')?.skipKind).toBe('unavailable');
  });

  it('plans the six built-in steps, skipping typecheck and furnace when unconfigured', () => {
    const plan = buildCheckPlan({
      projectRoot: '/project',
      config: DEFAULT_CONFIG,
      furnaceConfigured: false,
    });
    expect(plan.map((step) => step.name)).toEqual([
      'status',
      'verify',
      'lint',
      'typecheck',
      'furnace-validate',
      'token-coverage',
    ]);
    expect(plan.find((step) => step.name === 'typecheck')?.skipReason).toMatch(/typecheck/);
    expect(plan.find((step) => step.name === 'furnace-validate')?.skipReason).toBe(
      'no furnace.json'
    );
    expect(plan[0]?.display).toBe('fireforge status --json --summary --check');
    expect(plan.find((step) => step.name === 'furnace-validate')?.after).toEqual(['typecheck']);
  });

  it('forwards --patches, the status policy and warning budgets, and appends extra steps', () => {
    const plan = buildCheckPlan({
      projectRoot: '/project',
      config: {
        ...DEFAULT_CONFIG,
        typecheck: { projects: ['jsconfig.json'] },
        check: {
          skip: ['token-coverage'],
          status: { failOn: ['unmanaged', 'ownership-conflict'], allow: ['patch-backed'] },
          maxWarnings: { lint: 0, furnace: 2 },
          extraSteps: [{ name: 'audit', command: 'npm run audit', cwd: 'tools', timeout: 30 }],
        },
      },
      furnaceConfigured: true,
      patches: ['201-ui-a.patch', '246-ui-b.patch'],
    });
    const byName = new Map(plan.map((step) => [step.name, step]));
    expect(byName.get('status')?.display).toBe(
      'fireforge status --json --summary --check --fail-on unmanaged,ownership-conflict --allow patch-backed --patches 201-ui-a.patch,246-ui-b.patch'
    );
    expect(byName.get('verify')?.display).toBe(
      'fireforge verify --patches 201-ui-a.patch,246-ui-b.patch'
    );
    expect(byName.get('lint')?.display).toContain('--max-warnings 0 --patches');
    expect(byName.get('furnace-validate')?.display).toBe(
      'fireforge furnace validate --json --max-warnings 2'
    );
    expect(byName.get('typecheck')?.skipReason).toBeUndefined();
    expect(byName.get('token-coverage')?.skipReason).toMatch(/check\.skip/);
    expect(byName.get('audit')).toMatchObject({
      kind: 'extra',
      display: 'npm run audit',
      timeoutMs: 30_000,
    });
    expect(byName.get('audit')?.cwd).toMatch(/tools$/);
  });

  it('builds the status policy flags', () => {
    expect(statusPolicyArgs(undefined)).toEqual([]);
    expect(statusPolicyArgs({ allow: ['a'], failOnUnknown: true })).toEqual([
      '--allow',
      'a',
      '--fail-on-unknown',
    ]);
  });
});

describe('step summaries', () => {
  it('summarizes status from its JSON document', () => {
    const offenders = JSON.stringify({
      summary: { total: 3 },
      check: { offenders: [{ classification: 'unmanaged', count: 2 }] },
    });
    expect(summarizeStatus({ stdout: offenders, combined: '', exitCode: 1 })).toBe('2 unmanaged');
    expect(
      summarizeStatus({
        stdout: JSON.stringify({ summary: { total: 3 } }),
        combined: '',
        exitCode: 0,
      })
    ).toBe('3 changed file(s), none failing');
    expect(summarizeStatus({ stdout: 'nope', combined: '■  boom\n', exitCode: 1 })).toBe('boom');
  });

  it('summarizes furnace validation counts', () => {
    const doc = JSON.stringify({
      summary: { errors: 1, warnings: 2, excepted: 3, staleExceptions: 1 },
    });
    expect(summarizeFurnace({ stdout: doc, combined: '', exitCode: 1 })).toBe(
      '1 error(s), 2 warning(s), 3 excepted, 1 stale exception(s)'
    );
    expect(summarizeFurnace({ stdout: '', combined: 'x', exitCode: 0 })).toBe('');
  });

  it('summarizes token coverage', () => {
    expect(
      summarizeTokenCoverage({ stdout: '', combined: 'Token coverage: 87% (x)', exitCode: 0 })
    ).toBe('coverage 87%');
    expect(
      summarizeTokenCoverage({ stdout: '', combined: 'No modified CSS files', exitCode: 0 })
    ).toBe('no modified CSS');
    expect(summarizeTokenCoverage({ stdout: '', combined: 'x', exitCode: 0 })).toBe('');
  });

  it('cuts a long last line to fit a table cell', () => {
    expect(lastOutputLine(`${'x'.repeat(200)}\n`, 1)).toHaveLength(120);
    expect(lastOutputLine('anything', 0)).toBe('');
  });
});

describe('runCheckSteps', () => {
  function step(name: string, overrides: Partial<CheckStepPlan> = {}): CheckStepPlan {
    return {
      name,
      kind: 'extra',
      command: '/bin/sh',
      args: ['-c', name],
      display: name,
      cwd: '/project',
      after: [],
      summarize: ({ combined, exitCode }) => lastOutputLine(combined, exitCode),
      ...overrides,
    };
  }

  it('runs a step after its dependency and caps concurrency', async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    vi.mocked(execStream).mockImplementation(async (_command, args) => {
      active++;
      peak = Math.max(peak, active);
      order.push(`start:${args[1] ?? ''}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${args[1] ?? ''}`);
      active--;
      return 0;
    });
    const results = await runCheckSteps(
      [step('a'), step('b', { after: ['a'] }), step('c'), step('d', { after: ['absent'] })],
      2
    );
    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(peak).toBeLessThanOrEqual(2);
    expect(order.indexOf('start:b')).toBeGreaterThan(order.indexOf('end:a'));
  });

  it('reports skipped, failed, timed-out and unstartable steps', async () => {
    scriptChildren({
      red: { stdout: 'out\n', stderr: 'bad thing\n', exitCode: 2 },
      slow: { error: new ExecTimeoutError('/bin/sh', ['-c', 'slow'], 1000) },
      broken: { error: new Error('spawn ENOENT') },
    });
    const results = await runCheckSteps(
      [
        step('skip', { skipReason: 'not today' }),
        step('red'),
        step('slow', { timeoutMs: 1000 }),
        step('broken'),
      ],
      4
    );
    expect(results[0]).toMatchObject({ status: 'skipped', exitCode: null, detail: 'not today' });
    expect(results[1]).toMatchObject({
      status: 'fail',
      exitCode: 2,
      detail: 'bad thing',
      outputTail: 'out\nbad thing',
    });
    expect(results[2]).toMatchObject({
      status: 'fail',
      timedOut: true,
      detail: 'timed out after 1s',
    });
    expect(results[3]).toMatchObject({ status: 'fail', detail: 'could not start: spawn ENOENT' });
  });

  it('samples the host load when each step starts and ends', async () => {
    scriptChildren({
      green: { stdout: 'ok\n', exitCode: 0 },
      slow: { error: new ExecTimeoutError('/bin/sh', ['-c', 'slow'], 1000) },
    });
    const samples = [12.3, 18, 20.5, 31];
    const load = vi.fn(() => samples.shift());
    const results = await runCheckSteps(
      [
        step('skip', { skipReason: 'not today' }),
        step('green'),
        step('slow', { after: ['green'] }),
      ],
      1,
      Date.now,
      load
    );
    expect(results[0]).not.toHaveProperty('load1Start');
    expect(results[1]).toMatchObject({ load1Start: 12.3, load1End: 18 });
    // A step killed at its budget still says what the host was doing.
    expect(results[2]).toMatchObject({ timedOut: true, load1Start: 20.5, load1End: 31 });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('records no load where the host has no load average', async () => {
    scriptChildren({ green: { stdout: 'ok\n', exitCode: 0 } });
    const [result] = await runCheckSteps([step('green')], 1, Date.now, () => undefined);
    expect(result).toMatchObject({ status: 'pass' });
    expect(result).not.toHaveProperty('load1Start');
    expect(result).not.toHaveProperty('load1End');
  });
});

describe('check verdict and table', () => {
  it('passes when nothing failed and counts and names skips', () => {
    const verdict = judgeCheck([result({}), result({ name: 'typecheck', status: 'skipped' })]);
    expect(formatCheckVerdictLine(verdict)).toBe(
      'FIREFORGE-VERDICT: PASS steps=2 skipped=1 skipped-steps=typecheck'
    );
  });

  it('fails a step skipped for want of anything to run under failOnSkipped', () => {
    const results = [
      result({}),
      result({ name: 'typecheck', status: 'skipped', skipKind: 'unavailable' }),
      result({ name: 'token-coverage', status: 'skipped', skipKind: 'config' }),
    ];
    expect(judgeCheck(results).passed).toBe(true);
    const verdict = judgeCheck(results, { failOnSkipped: true });
    expect(verdict).toMatchObject({
      passed: false,
      reason: 'skipped-steps',
      failed: ['typecheck'],
    });
    expect(formatCheckVerdictLine(verdict)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=skipped-steps failed=typecheck steps=3 skipped=2 skipped-steps=typecheck,token-coverage'
    );
    const red = judgeCheck([...results, result({ name: 'lint', status: 'fail', exitCode: 1 })], {
      failOnSkipped: true,
    });
    expect(red.reason).toBe('step-failures');
  });

  it('names lock-timeout only when every failure exited 15', () => {
    expect(
      judgeCheck([result({ status: 'fail', exitCode: 15 }), result({ name: 'lint' })]).reason
    ).toBe('lock-timeout');
    const mixed = judgeCheck([
      result({ status: 'fail', exitCode: 15 }),
      result({ name: 'lint', status: 'fail', exitCode: 1 }),
    ]);
    expect(formatCheckVerdictLine(mixed)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=step-failures failed=status,lint steps=2 skipped=0'
    );
  });

  it('aligns the table columns', () => {
    expect(
      formatCheckTable([
        result({ durationMs: 1500, detail: 'ok', load1Start: 12.34, load1End: 18 }),
        result({ name: 'lint', durationMs: 900, detail: 'ok' }),
        result({ name: 'furnace-validate', status: 'skipped', detail: 'no furnace.json' }),
      ])
    ).toBe(
      [
        'STEP              RESULT   TIME   LOAD       DETAIL',
        'status            PASS     1.5s   12.3→18.0  ok',
        'lint              PASS     900ms  -          ok',
        'furnace-validate  SKIPPED  -      -          no furnace.json',
      ].join('\n')
    );
  });
});

describe('selectCheckSteps and parseCheckJobs', () => {
  const plan = buildCheckPlan({
    projectRoot: '/project',
    config: DEFAULT_CONFIG,
    furnaceConfigured: false,
  });

  it('keeps --only steps and drops --skip steps', () => {
    expect(selectCheckSteps(plan, { only: 'status, lint' }).map((s) => s.name)).toEqual([
      'status',
      'lint',
    ]);
    expect(selectCheckSteps(plan, { skip: 'lint' }).map((s) => s.name)).not.toContain('lint');
  });

  it('refuses an unknown step name', () => {
    expect(() => selectCheckSteps(plan, { skip: 'nope' })).toThrow('Unknown --skip step "nope"');
  });

  it('parses --jobs', () => {
    expect(parseCheckJobs('3')).toBe(3);
    expect(parseCheckJobs(undefined)).toBeGreaterThanOrEqual(1);
    expect(() => parseCheckJobs('0')).toThrow('--jobs must be a positive integer.');
  });
});

describe('checkCommand', () => {
  it('passes, prints the table, and ends with the verdict line', async () => {
    scriptChildren({ status: { stdout: JSON.stringify({ summary: { total: 0 } }) } });
    const out = capture();
    try {
      await checkCommand('/project', { only: 'status,verify', jobs: '2' });
    } finally {
      out.restore();
    }
    expect(out.text()).toBe('FIREFORGE-VERDICT: PASS steps=2 skipped=0\n');
    expect(note).toHaveBeenCalledWith(expect.stringContaining('none failing'), 'Steps');
    expect(setStdoutSealed).toHaveBeenCalledWith(true);
  });

  it('fails under --json with one document and exit-1 error', async () => {
    scriptChildren({ verify: { stderr: 'broken queue\n', exitCode: 1 } });
    const out = capture();
    try {
      await expect(checkCommand('/project', { json: true, only: 'verify' })).rejects.toThrow(
        'fireforge check failed: verify'
      );
    } finally {
      out.restore();
    }
    expect(JSON.parse(out.text())).toMatchObject({
      schemaVersion: 1,
      verdict: 'fail',
      reason: 'step-failures',
      summary: { steps: 1, passed: 0, failed: 1, skipped: 0 },
    });
    expect(setMachineOutputMode).toHaveBeenCalledWith(true);
  });

  it('throws a lock-contention error when every failure was a lock timeout', async () => {
    scriptChildren({ lint: { exitCode: 15 } });
    const out = capture();
    try {
      await expect(checkCommand('/project', { only: 'lint' })).rejects.toMatchObject({
        code: 15,
      });
    } finally {
      out.restore();
    }
  });

  it('refuses an invalid check.status policy as a config error before running', async () => {
    withConfig({ check: { status: { failOnUnknown: true } } });
    await expect(checkCommand('/project')).rejects.toThrow(
      /Config field "check.status" is invalid: --fail-on-unknown requires --allow/
    );
    expect(execStream).not.toHaveBeenCalled();
  });

  it('resolves --patches once and refuses without a queue', async () => {
    await expect(checkCommand('/project', { patches: ['201'] })).rejects.toThrow(
      '--patches needs a patch queue'
    );
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '201-ui-a.patch',
          order: 201,
          category: 'ui',
          name: 'a',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: [],
        },
      ],
    });
    scriptChildren({});
    const out = capture();
    try {
      await checkCommand('/project', { patches: ['201'], only: 'verify' });
    } finally {
      out.restore();
    }
    expect(vi.mocked(execStream).mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['verify', '--patches', '201-ui-a.patch'])
    );
  });
});
