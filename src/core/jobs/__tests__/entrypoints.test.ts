// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executorFingerprint, testStepEvidence } from '../evidence.js';
import { readAdmittedSnapshot } from '../guard.js';
import { holdFront } from '../hold-front.js';
import { runQualificationPhase } from '../native-qualify.js';
import { LocalSupervisor } from '../supervisor.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../evidence.js', () => ({
  executorFingerprint: vi.fn(() => Promise.resolve('tools')),
  executionEnvironmentDigest: () => 'environment',
  testStepEvidence: vi.fn(() => Promise.resolve({ selectedFiles: ['a.js'] })),
}));
vi.mock('../check-evidence.js', () => ({
  readCheckEvidence: () => Promise.resolve({ resultDigest: 'fixture-check' }),
}));
vi.mock('../guard.js', () => ({
  readAdmittedSnapshot: vi.fn(() => Promise.resolve({ snapshot: { id: 'source' } })),
}));
vi.mock('../supervisor.js', () => ({
  LocalSupervisor: { start: vi.fn(() => Promise.resolve({})) },
}));
vi.mock('../hold-front.js', () => ({ holdFront: vi.fn() }));
vi.mock('../native-qualify.js', () => ({ runQualificationPhase: vi.fn() }));
let directory: string;
const id = '11111111-1111-1111-1111-111111111111';
const runtime = {
  sourceGeneration: 1,
  successfulBuildGeneration: 1,
  materializationDigest: 'ledger',
  derivedDigest: 'derived',
};
const savedSend = Object.getOwnPropertyDescriptor(process, 'send');
let savedExit: typeof process.exitCode;
const sendMock = vi.fn(() => true);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ff-executor-fixture-'));
  savedExit = process.exitCode;
  vi.stubEnv('FIREFORGE_COORDINATOR', directory);
  vi.stubEnv('FIREFORGE_JOB_ID', id);
  Object.defineProperty(process, 'send', { configurable: true, value: sendMock });
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter();
    setTimeout(() => child.emit('exit', 0, null), 1);
    return child as ChildProcess;
  });
});
afterEach(async () => {
  process.exitCode = savedExit;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (savedSend) Object.defineProperty(process, 'send', savedSend);
  else Reflect.deleteProperty(process, 'send');
  await rm(directory, { recursive: true, force: true });
});
async function execute(
  step: {
    command: string;
    args: string[];
    keepAwake?: boolean;
    holdFront?: boolean;
    validate?: { command: string[] };
  },
  cpu = 2
): Promise<Record<string, unknown>> {
  const { runOwnedExecutor } = await import('../runner.js');
  const pending = runOwnedExecutor();
  process.emit('message', { step, index: 0, runtime, cpu });
  await pending;
  return JSON.parse(
    await readFile(join(directory, 'artifacts', id, 'step-0-execution.json'), 'utf8')
  ) as Record<string, unknown>;
}

describe('owned executor entry lifecycle', () => {
  it('boots the actual entry, bounds child CLI concurrency and preserves per-step artifact identities', async () => {
    const pending = import('../runner-main.js');
    // The import installs its IPC handler before sending ready.
    for (let n = 0; n < 100 && sendMock.mock.calls.length === 0; n++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    process.emit('message', { step: { command: 'check', args: [] }, index: 0, runtime, cpu: 2 });
    await pending;
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('check');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.slice(-2)).toEqual(['--jobs', '2']);
    const report = JSON.parse(
      await readFile(join(directory, 'artifacts', id, 'step-0-execution.json'), 'utf8')
    ) as { steps: Array<{ runtimeBefore: unknown; exitCode: number }> };
    expect(report.steps[0]).toMatchObject({ runtimeBefore: runtime, exitCode: 0 });
  });
  it('owns unique results paths and obtains actual admitted source before certifying a test', async () => {
    await execute({ command: 'test', args: ['--headless'] });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--results');
    expect(readAdmittedSnapshot).toHaveBeenCalled();
    expect(testStepEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('results.json'),
      { id: 'source' }
    );
  });
  it('uses private temporary profiles and rejects an actual named-profile alias before launch', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    try {
      await execute({ command: 'run', args: [], keepAwake: false });
      expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--temp-profile');
      vi.mocked(spawn).mockClear();
      await mkdir(join(directory, '.fireforge', 'profiles'), { recursive: true });
      await execute({
        command: 'run',
        args: ['--profile', '.fireforge/profiles/fresh'],
        keepAwake: false,
      });
      expect(spawn).toHaveBeenCalled();
      vi.mocked(spawn).mockClear();
      await symlink(directory, join(directory, '.fireforge', 'profiles', 'alias'));
      const report = await execute({
        command: 'run',
        args: ['--profile', '.fireforge/profiles/alias'],
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(report['steps']).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      cwd.mockRestore();
    }
  });
  it('builds with the granted CPU, preserves explicit concurrency and cancels before dispatch', async () => {
    await execute({ command: 'build', args: [] }, 10);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.slice(-2)).toEqual(['--jobs', '10']);
    vi.mocked(spawn).mockClear();
    await execute({ command: 'check', args: ['--jobs', '1'] }, 10);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.slice(-3)).toEqual(['check', '--jobs', '1']);
    const { runOwnedExecutor } = await import('../runner.js');
    const pending = runOwnedExecutor();
    process.emit('SIGTERM');
    process.emit('message', { step: { command: 'status', args: [] }, index: 0, runtime, cpu: 2 });
    await pending;
    const report = JSON.parse(
      await readFile(join(directory, 'artifacts', id, 'step-0-execution.json'), 'utf8')
    ) as { steps: unknown[] };
    expect(report.steps).toEqual([]);
    vi.stubEnv('FIREFORGE_JOB_ID', 'invalid');
    await expect(runOwnedExecutor()).rejects.toThrow(/identity/);
  });
  it('stops after a failed child or a termination signal and always writes failed evidence', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter();
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1);
      return child as ChildProcess;
    });
    const report = await execute({ command: 'status', args: [] });
    expect(report['steps']).toHaveLength(1);
    expect(process.exitCode).toBe(143);
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter();
      setTimeout(() => {
        process.emit('SIGINT');
        child.emit('exit', 0, null);
      }, 1);
      return child as ChildProcess;
    });
    await execute({ command: 'status', args: [] });
    expect(process.exitCode).toBe(143);
  });
  it('lets a validator judge a clean harness: its exit is the step, and a red harness skips it', async () => {
    const exits = (...codes: number[]): void => {
      for (const code of codes)
        vi.mocked(spawn).mockImplementationOnce(() => {
          const child = new EventEmitter();
          setTimeout(() => child.emit('exit', code, null), 1);
          return child as ChildProcess;
        });
    };
    const step = {
      command: 'status',
      args: [],
      validate: { command: ['node', 'tools/v.mjs'] },
    };
    exits(0, 3);
    const judged = (await execute(step)) as { steps: Array<Record<string, unknown>> };
    expect(judged.steps[0]).toMatchObject({ exitCode: 3, validated: ['node', 'tools/v.mjs'] });
    expect(vi.mocked(spawn).mock.calls[1]?.[0]).toBe(process.execPath);
    expect(vi.mocked(spawn).mock.calls[1]?.[1]).toEqual(['tools/v.mjs']);
    vi.mocked(spawn).mockClear();
    exits(5);
    const red = (await execute(step)) as { steps: Array<Record<string, unknown>> };
    expect(red.steps[0]).toMatchObject({ exitCode: 5 });
    expect(spawn).toHaveBeenCalledOnce();
  });
  it('reddens a passing step whose browser could not be held in front', async () => {
    vi.mocked(holdFront).mockReturnValue({
      finish: () => Promise.resolve({ raises: 3, failures: 3, failed: 'behind another window' }),
    });
    const step = { command: 'status', args: [], holdFront: true };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    try {
      const held = (await execute(step)) as { steps: Array<Record<string, unknown>> };
      expect(held.steps[0]).toMatchObject({ exitCode: 1 });
      expect(held.steps[0]?.['front']).toMatchObject({ failed: 'behind another window' });
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const off = (await execute(step)) as { steps: Array<Record<string, unknown>> };
      expect(off.steps[0]).toMatchObject({ exitCode: 1 });
      expect((off.steps[0]?.['front'] as { failed?: string }).failed).toMatch(/darwin/);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
  it('runs a qualification in the phase itself, and reads its failure as the step', async () => {
    vi.mocked(runQualificationPhase).mockResolvedValueOnce();
    const passed = (await execute({ command: 'qualify-native', args: [] })) as {
      steps: Array<Record<string, unknown>>;
    };
    expect(passed.steps[0]).toMatchObject({ exitCode: 0 });
    expect(spawn).not.toHaveBeenCalled();
    vi.mocked(runQualificationPhase).mockRejectedValueOnce(new Error('no tools'));
    const failed = (await execute({ command: 'qualify-native', args: [] })) as {
      steps: Array<Record<string, unknown>>;
    };
    expect(failed.steps[0]).toMatchObject({ exitCode: 1 });
  });
  it('refuses malformed phase steps without dispatching arbitrary work', async () => {
    const report = await execute(undefined as unknown as { command: string; args: string[] });
    expect(report['steps']).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(executorFingerprint).toHaveBeenCalled();
  });
  it('starts only an explicit coordinator namespace', async () => {
    const start = vi.spyOn(LocalSupervisor, 'start');
    const old = process.argv[2];
    process.argv[2] = directory;
    try {
      const entry = await import('../supervisor-main.js');
      await expect(entry.startOwnedCoordinator(undefined)).rejects.toThrow(/Missing coordinator/);
      expect(start).toHaveBeenCalledWith(directory);
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.argv, 2);
      else process.argv[2] = old;
    }
  });
  it('ends a supervisor start by what stopped it, and logs what escapes', async () => {
    const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = new Set(process.listeners('unhandledRejection'));
    const old = process.argv[2];
    process.argv[2] = directory;
    try {
      vi.resetModules();
      const lost = await import('../election.js');
      const supervisor = await import('../supervisor.js');
      vi.spyOn(supervisor.LocalSupervisor, 'start').mockRejectedValueOnce(
        new lost.ElectionLostError('held')
      );
      await import('../supervisor-main.js');
      expect(written).toHaveBeenCalledWith('Supervisor did not start: held\n');
      expect(process.exitCode).toBe(0);

      vi.resetModules();
      const next = await import('../supervisor.js');
      vi.spyOn(next.LocalSupervisor, 'start').mockRejectedValueOnce(new Error('damaged'));
      await import('../supervisor-main.js');
      expect(written).toHaveBeenCalledWith('Supervisor did not start: damaged\n');
      expect(process.exitCode).toBe(1);

      const added = process.listeners('unhandledRejection').filter((entry) => !before.has(entry));
      expect(added.length).toBeGreaterThan(0);
      added[0]?.('escaped', Promise.resolve());
      expect(written).toHaveBeenCalledWith('Unhandled supervisor rejection: escaped\n');
    } finally {
      process.argv[2] = old as string;
      for (const entry of process.listeners('unhandledRejection'))
        if (!before.has(entry)) process.off('unhandledRejection', entry);
      written.mockRestore();
    }
  });
});
