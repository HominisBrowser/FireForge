// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('node:os', () => ({ loadavg: vi.fn(() => [6, 5, 4]) }));

import { PreflightRefusalError } from '../../errors/base.js';
import { exec } from '../../utils/process.js';
import { waitForPreflight } from '../preflight-wait.js';
import { isOrphanedHarness, isStillOrphanedProcess, readProcessOwner } from '../process-owner.js';
import { reportTestHost, sampleTestHost } from '../test-host-state.js';

const platform = process.platform;
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});
function result(
  stdout: string,
  exitCode = 0
): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr: '', exitCode };
}

it('names a live parent, never calls profile/marionette arguments alone orphan evidence', async () => {
  vi.mocked(exec)
    .mockResolvedValueOnce(result('99\n'))
    .mockResolvedValueOnce(result('node fireforge test --headless\n'));
  expect(await readProcessOwner(42)).toEqual({
    parentPid: 99,
    owner: 'node fireforge test --headless',
  });
  expect(isOrphanedHarness('hominis -marionette -profile /peer/scratch', 99)).toBe(false);
  expect(isOrphanedHarness('hominis -profile /peer/scratch', 1)).toBe(false);
  expect(isOrphanedHarness('hominis -marionette', 1)).toBe(true);
  expect(isOrphanedHarness('hominis -profile /tmp/fireforge-profile-123', 1)).toBe(true);
});

it('requires positive parent evidence and remains conservative when probes fail', async () => {
  vi.mocked(exec).mockResolvedValueOnce(result('1\n'));
  expect(await readProcessOwner(42)).toEqual({
    parentPid: 1,
    owner: 'init/launchd (parent exited)',
  });
  vi.mocked(exec).mockResolvedValueOnce(result('')).mockResolvedValueOnce(result('NaN'));
  expect(await readProcessOwner(42)).toBeUndefined();
  expect(await readProcessOwner(42)).toBeUndefined();
  vi.mocked(exec).mockResolvedValueOnce(result('99')).mockResolvedValueOnce(result('', 1));
  expect(await readProcessOwner(42)).toBeUndefined();
  vi.mocked(exec).mockRejectedValueOnce(new Error('ps absent'));
  expect(await readProcessOwner(42)).toBeUndefined();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expect(await readProcessOwner(42)).toBeUndefined();
});

it('queues behind busy resources until released, without treating other errors as busy', async () => {
  vi.useFakeTimers();
  const busy = new PreflightRefusalError('peer browser busy', 'browser-busy');
  const probe = vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce(undefined);
  const waiting = waitForPreflight(probe, 2);
  await vi.advanceTimersByTimeAsync(500);
  await waiting;
  expect(probe).toHaveBeenCalledTimes(2);
  await expect(
    waitForPreflight(() => Promise.reject(new Error('real failure')), 2)
  ).rejects.toThrow('real failure');
  await expect(waitForPreflight(() => Promise.reject(busy))).rejects.toBe(busy);
});

it('expires a stalled wait with its actionable refusal intact', async () => {
  vi.useFakeTimers();
  const busy = new PreflightRefusalError('8888 owned by peer', 'mochitest-port-busy');
  const waiting = waitForPreflight(() => Promise.reject(busy), 1);
  const rejected = expect(waiting).rejects.toBe(busy);
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
});

it('uses pmset power-source output while charging and records a pegged system daemon', async () => {
  vi.mocked(exec)
    .mockResolvedValueOnce(result('97 /System/ANECompilerService\n10 node\n'))
    .mockResolvedValueOnce(result("Now drawing from 'AC Power'\n95%; charging"));
  const state = await sampleTestHost();
  expect(state.power).toBe('ac');
  expect(state.topProcess?.cpu).toBe(97);
  expect(vi.mocked(exec).mock.calls[1]?.[1]).toEqual(['-g', 'ps']);
  expect(reportTestHost(state, 'start')).toBe(true);
  expect(reportTestHost({ load: 1, power: 'ac' }, 'start')).toBe(false);
  vi.mocked(exec)
    .mockResolvedValueOnce(result(''))
    .mockResolvedValueOnce(result("Now drawing from 'Battery Power'"));
  expect((await sampleTestHost()).power).toBe('battery');
  vi.mocked(exec).mockRejectedValue(new Error('tool absent'));
  expect((await sampleTestHost()).power).toBe('unknown');
});

it('renews exact orphan identity and refuses live, replaced, unreadable or Windows ownership', async () => {
  vi.mocked(exec)
    .mockResolvedValueOnce(result('1 browser -marionette'))
    .mockResolvedValueOnce(result('99 browser -marionette'))
    .mockResolvedValueOnce(result('1 unrelated'))
    .mockRejectedValueOnce(new Error('ps failed'));
  expect(await isStillOrphanedProcess(42, 'browser -marionette')).toBe(true);
  expect(await isStillOrphanedProcess(42, 'browser -marionette')).toBe(false);
  expect(await isStillOrphanedProcess(42, 'browser -marionette')).toBe(false);
  expect(await isStillOrphanedProcess(42, 'browser -marionette')).toBe(false);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expect(await isStillOrphanedProcess(42, 'browser -marionette')).toBe(false);
});

it.each([
  { label: 'failed ps with plausible output', stdout: '1 browser -marionette', exitCode: 1 },
  { label: 'empty output', stdout: '', exitCode: 0 },
  { label: 'malformed parent', stdout: 'unknown browser -marionette', exitCode: 0 },
  { label: 'missing command', stdout: '1', exitCode: 0 },
])('refuses renewal with $label', async ({ stdout, exitCode }) => {
  vi.mocked(exec).mockResolvedValueOnce(result(stdout, exitCode));
  expect(await isStillOrphanedProcess(42, 'browser -marionette')).toBe(false);
});
