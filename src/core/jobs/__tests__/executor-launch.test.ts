// SPDX-License-Identifier: EUPL-1.2
import { ChildProcess, spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { launchExecutor } from '../executor.js';
import { nativeToolEnvironment, needsNativeTools, readHostToolchain } from '../native-tools.js';
import { processIdentityAsync, signalOwnedProcess } from '../process.js';
import type { JobRecord } from '../schema.js';
import { readJson, writeDurableBytes } from '../store.js';

const fixture = vi.hoisted(() => ({ close: vi.fn(() => Promise.resolve()) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: vi.fn(() => Promise.resolve({ fd: 42, close: fixture.close })),
}));
vi.mock('../../../utils/process-group.js', () => ({ ownProcessTree: vi.fn(() => undefined) }));
vi.mock('../native-tools.js', () => ({
  needsNativeTools: vi.fn(() => false),
  readHostToolchain: vi.fn(() => Promise.resolve({ schemaVersion: 2 })),
  nativeToolEnvironment: vi.fn(() => ({
    PATH: '/qualified/native',
    MACHRC: '/owned/empty-machrc',
  })),
}));
vi.mock('../../git-hermetic.js', () => ({
  hermeticGitEnvironment: () => ({
    GIT_EXEC_PATH: '/qualified/git-core',
    GIT_CONFIG_NOSYSTEM: '1',
  }),
}));
vi.mock('../process.js', () => ({
  processIdentityAsync: vi.fn((pid: number) =>
    Promise.resolve({ pid, start: 'actual-owned-birth' })
  ),
  signalOwnedProcess: vi.fn(() => true),
}));
vi.mock('../source-loader.js', async (original) => ({
  ...(await original<typeof import('../source-loader.js')>()),
  assertSourceLoaderEnvironment: vi.fn(),
}));
vi.mock('../store.js', () => ({
  readJson: vi.fn(() => Promise.resolve({ id: 'captured-source' })),
  writeDurableBytes: vi.fn(() => Promise.resolve()),
  ensurePrivateNamespace: vi.fn(() => Promise.resolve()),
}));

const runtime = {
  sourceGeneration: 7,
  successfulBuildGeneration: 3,
  materializationDigest: 'materialized',
  derivedDigest: 'derived',
};
const namespace = '/private/fixture namespace',
  root = '/owned/stable-slot';
let child: ChildProcess;
let disconnected: ReturnType<typeof vi.fn>;
let sent: ReturnType<typeof vi.fn>;
let rawKill: ReturnType<typeof vi.fn>;
function request(): JobRecord {
  return {
    schemaVersion: 1,
    id: 'job-id',
    owner: 'caller',
    request: {
      schemaVersion: 1,
      key: 'key',
      sourceId: 'a'.repeat(64),
      slot: 'alpha',
      steps: [
        { command: 'status', args: [] },
        { command: 'build', args: ['--jobs', '2'] },
      ],
      resources: { cpu: 2, memory: 2, build: 1, browser: 1, display: 1 },
      quiet: false,
    },
    state: 'running',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    phase: { index: 1, active: true, ticket: 1, nonce: 'private-phase' },
    gitExecutable: '/qualified/git',
    gitExecPath: '/qualified/git-core',
    qualityToolsDigest: 'qualified-tools',
  };
}
beforeEach(() => {
  vi.stubEnv('NODE_OPTIONS', undefined);
  disconnected = vi.fn(() => {
    Object.assign(child, { connected: false });
  });
  sent = vi.fn((_message: unknown, callback?: () => void) => callback?.());
  rawKill = vi.fn();
  child = Object.assign(new ChildProcess(), {
    pid: 12345,
    connected: true,
    disconnect: disconnected,
    send: sent,
    kill: rawKill,
  });
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(processIdentityAsync).mockImplementation((pid) =>
    Promise.resolve({ pid, start: 'actual-owned-birth' })
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('keeps the adapter behind readiness and binds one exact phase, source/native runtime and private capability', async () => {
  const job = request();
  vi.mocked(needsNativeTools).mockReturnValueOnce(true);
  const owned = await launchExecutor(namespace, job, root);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(readJson).toHaveBeenCalledWith(`${namespace}/slots/alpha/snapshot.json`);
  expect(readHostToolchain).toHaveBeenCalledWith(namespace);
  expect(nativeToolEnvironment).toHaveBeenCalledWith({ schemaVersion: 2 }, root, '/qualified/git');
  const options = vi.mocked(spawn).mock.calls[0]?.[2];
  expect(options).toMatchObject({
    cwd: root,
    detached: true,
    stdio: ['ignore', 42, 42, 'ipc'],
    env: {
      PATH: '/qualified/native',
      GIT_EXEC_PATH: '/qualified/git-core',
      FIREFORGE_EXECUTION_ROOT: root,
      FIREFORGE_JOB_PHASE: 'private-phase',
      FIREFORGE_ADAPTER_COMMAND: 'build',
      FIREFORGE_JOB_TOKEN: owned.token,
      FIREFORGE_QUALITY_TOOLS_DIGEST: 'qualified-tools',
      NODE_DISABLE_COMPILE_CACHE: '1',
    },
  });
  expect(owned.token).toMatch(/^[a-f0-9]{64}$/);
  expect(options?.env?.['NODE_OPTIONS']).toContain('cli-cache-hook.cjs');
  const pending = owned.start(runtime, 3);
  expect(sent).not.toHaveBeenCalled();
  child.emit('message', { ready: true });
  await pending;
  expect(sent).toHaveBeenCalledWith(
    { step: job.request.steps[1], index: 1, runtime, cpu: 3 },
    expect.any(Function)
  );
  expect(disconnected).toHaveBeenCalledOnce();
  expect(rawKill).not.toHaveBeenCalled();
});

it('passes nothing from the caller’s environment beyond the allowlist', async () => {
  vi.stubEnv('NODE_OPTIONS', '--require /unqualified/input.cjs');
  vi.stubEnv('MOZ_PEER_SETTING', 'from-another-agent');
  await launchExecutor(namespace, request(), root);
  const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
  expect(env?.['NODE_OPTIONS']).toContain('cli-cache-hook.cjs');
  expect(env?.['NODE_OPTIONS']).not.toContain('unqualified');
  expect(env?.['MOZ_PEER_SETTING']).toBeUndefined();
});

it('does not open a log when native qualification or private hook preparation refuses', async () => {
  const job = request();
  vi.mocked(needsNativeTools).mockReturnValueOnce(true);
  vi.mocked(readHostToolchain).mockRejectedValueOnce(new Error('manifest unavailable'));
  await expect(launchExecutor(namespace, job, root)).rejects.toThrow(/manifest unavailable/);
  expect(open).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  vi.mocked(writeDurableBytes).mockRejectedValueOnce(new Error('artifact fsync refused'));
  await expect(launchExecutor(namespace, request(), root)).rejects.toThrow(/fsync refused/);
  expect(open).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('closes the log exactly once on synchronous spawn failure before any ownership can be granted', async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw new Error('spawn arguments invalid');
  });
  await expect(launchExecutor(namespace, request(), root)).rejects.toThrow(/spawn arguments/);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(signalOwnedProcess).not.toHaveBeenCalled();
  expect(rawKill).not.toHaveBeenCalled();
});

it.each([false, true])(
  'never raw-kills an unidentified child, including async ENOENT (IPC connected=%s)',
  async (connected) => {
    Object.assign(child, { pid: undefined, connected });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      );
      return child;
    });
    await expect(launchExecutor(namespace, request(), root)).rejects.toThrow(/Cannot identify/);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledTimes(connected ? 1 : 0);
    expect(processIdentityAsync).not.toHaveBeenCalled();
    expect(signalOwnedProcess).not.toHaveBeenCalled();
    expect(rawKill).not.toHaveBeenCalled();
  }
);

it.each([null, 0, {}, { ready: false }])(
  'refuses malformed readiness and signals only the recorded owned birth (%j)',
  async (message) => {
    const owned = await launchExecutor(namespace, request(), root);
    child.emit('message', message);
    await expect(owned.start(runtime, 3)).rejects.toThrow(/Invalid executor readiness/);
    expect(sent).not.toHaveBeenCalled();
    expect(signalOwnedProcess).toHaveBeenCalledWith(
      { pid: 12345, start: 'actual-owned-birth' },
      'SIGTERM'
    );
    expect(rawKill).not.toHaveBeenCalled();
  }
);

it.each(['error', 'exit'] as const)(
  'attaches readiness listeners before an early async %s can win the startup race',
  async (event) => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() =>
        event === 'error'
          ? child.emit('error', new Error('early launch error'))
          : child.emit('exit', 1)
      );
      return child;
    });
    const owned = await launchExecutor(namespace, request(), root);
    await expect(owned.start(runtime, 3)).rejects.toThrow(
      event === 'error' ? /early launch error/ : /exited before ready/
    );
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
  }
);

it('refuses missing phase and adapter before allocating a runtime or log', async () => {
  const noPhase = request();
  delete noPhase.phase;
  await expect(launchExecutor(namespace, noPhase, root)).rejects.toThrow(/Missing executor phase/);
  const noStep = request();
  noStep.request.steps = [];
  await expect(launchExecutor(namespace, noStep, root)).rejects.toThrow(/Missing adapter/);
  expect(open).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
