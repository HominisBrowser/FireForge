// SPDX-License-Identifier: EUPL-1.2
/**
 * The teardown reaper against real processes: what the harness announced is
 * terminated only while its exact birth and objdir still say it is this run's.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ProcessBirth,
  processHasExitedAsync,
  processIdentity,
  sameProcess,
} from '../../utils/process-birth.js';
import { reapTrackedHarnessPids } from '../harness-helper-pids.js';

const directories: string[] = [];
const started: ChildProcess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function objdirBrowser(): Promise<{ objDir: string; binary: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ff-reap-'));
  directories.push(root);
  const objDir = join(root, 'obj');
  await mkdir(join(objDir, 'dist'), { recursive: true });
  const binary = join(objDir, 'dist', 'browser');
  await writeFile(binary, '#!/bin/sh\nexec sleep 30\n');
  await chmod(binary, 0o755);
  return { objDir, binary };
}

function run(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  started.push(child);
  return child;
}

async function birthOf(pid: number): Promise<ProcessBirth> {
  return vi.waitFor(() => {
    const identity = processIdentity(pid);
    if (identity === undefined) throw new Error('not running yet');
    return identity;
  });
}

describe.skipIf(process.platform === 'win32')('reapTrackedHarnessPids', () => {
  it('terminates an announced process still under this objdir', async () => {
    const { objDir } = await objdirBrowser();
    // The command line carries the objdir, as the browser's does.
    const child = run(process.execPath, [
      '-e',
      'setTimeout(()=>{},30000)',
      join(objDir, 'dist', 'browser'),
    ]);
    const identity = await birthOf(child.pid ?? 0);

    const reaped = await reapTrackedHarnessPids(
      [{ pid: identity.pid, kind: 'Application', identity }],
      objDir
    );

    expect(reaped).toBe(1);
    await vi.waitFor(() => {
      expect(sameProcess(identity)).toBe(false);
    });
  });

  it('leaves a process whose birth differs from the announcement', async () => {
    const { objDir } = await objdirBrowser();
    const child = run(process.execPath, [
      '-e',
      'setTimeout(()=>{},30000)',
      join(objDir, 'dist', 'browser'),
    ]);
    const identity = await birthOf(child.pid ?? 0);

    const reaped = await reapTrackedHarnessPids(
      [
        {
          pid: identity.pid,
          kind: 'Application',
          identity: { pid: identity.pid, start: 'a-different-birth' },
        },
      ],
      objDir
    );

    expect(reaped).toBe(0);
    await expect(processHasExitedAsync(identity)).resolves.toBe(false);
  });

  it('leaves an announced process that no longer names this objdir', async () => {
    const { objDir } = await objdirBrowser();
    const child = run(process.execPath, [
      '-e',
      'setTimeout(()=>{},30000)',
      '/elsewhere/obj/browser',
    ]);
    const identity = await birthOf(child.pid ?? 0);

    const reaped = await reapTrackedHarnessPids(
      [{ pid: identity.pid, kind: 'Application', identity }],
      objDir
    );

    expect(reaped).toBe(0);
    await expect(processHasExitedAsync(identity)).resolves.toBe(false);
  });
});
