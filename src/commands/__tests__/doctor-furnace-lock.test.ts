// SPDX-License-Identifier: EUPL-1.2
/**
 * "Furnace lock" doctor-check tests. This check had no coverage at all before
 * 0.41.0, and its liveness probe read EPERM as "owner is dead" — so
 * `doctor --repair-furnace` deleted a furnace lock held by a live process
 * running under a different uid, dropping mutual exclusion under a concurrent
 * furnace operation. The EPERM case below is the regression net for that.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getFurnaceLockPath } from '../../core/furnace-operation.js';
import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { DoctorCheck } from '../../types/commands/index.js';
import { pathExists } from '../../utils/fs.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from '../doctor-check-core.js';
import { FURNACE_DOCTOR_CHECKS } from '../doctor-furnace.js';

const lockCheck = FURNACE_DOCTOR_CHECKS.find(
  (c): c is DoctorCheckDefinition => c.name === 'Furnace lock'
);

/** Minimal context: the lock check reads only `projectRoot` and `options`. */
function makeContext(projectRoot: string, repairFurnace: boolean): DoctorCheckContext {
  return {
    projectRoot,
    options: { repairFurnace },
    furnaceConfigExists: true,
  } as unknown as DoctorCheckContext;
}

async function runLockCheck(projectRoot: string, repairFurnace: boolean): Promise<DoctorCheck> {
  if (!lockCheck) throw new Error('"Furnace lock" check is not registered');
  const result = await lockCheck.run(makeContext(projectRoot, repairFurnace));
  return Array.isArray(result) ? (result[0] as DoctorCheck) : result;
}

describe('furnace stale-lock doctor check', () => {
  let projectRoot: string;
  let lockPath: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-doctor-furnace-lock-');
    lockPath = getFurnaceLockPath(projectRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  async function plantLock(pidContent: string | null): Promise<void> {
    await mkdir(lockPath, { recursive: true });
    if (pidContent !== null) {
      await writeFile(join(lockPath, 'pid'), pidContent, 'utf-8');
    }
  }

  it('is registered and reports OK when no lock directory exists', async () => {
    expect(lockCheck).toBeDefined();
    const check = await runLockCheck(projectRoot, false);
    expect(check).toMatchObject({ name: 'Furnace lock', severity: 'ok' });
  });

  it('reports OK for a lock whose owner is alive', async () => {
    await plantLock(`${String(process.pid)}\ntoken\n`);
    const check = await runLockCheck(projectRoot, true);
    expect(check.severity).toBe('ok');
    await expect(pathExists(lockPath)).resolves.toBe(true);
  });

  it('treats an EPERM liveness probe as ALIVE and preserves the lock under --repair-furnace', async () => {
    await plantLock('12345\ntoken\n');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    const check = await runLockCheck(projectRoot, true);

    expect(check.severity).toBe('ok');
    expect(check.message).not.toMatch(/no longer running/);
    await expect(pathExists(lockPath)).resolves.toBe(true);
  });

  it('removes a lock whose owner answered ESRCH under --repair-furnace', async () => {
    await plantLock('12345\ntoken\n');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    const check = await runLockCheck(projectRoot, true);

    expect(check.severity).toBe('warning');
    expect(check.message).toMatch(/Removed stale furnace lock/);
    await expect(pathExists(lockPath)).resolves.toBe(false);
  });

  it('warns without removing when the owner is dead but --repair-furnace is off', async () => {
    await plantLock('12345\ntoken\n');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    const check = await runLockCheck(projectRoot, false);

    expect(check.severity).toBe('warning');
    expect(check.message).toMatch(/owner PID 12345 is no longer running/);
    expect(check.fix).toMatch(/--repair-furnace/);
    await expect(pathExists(lockPath)).resolves.toBe(true);
  });

  it('parses the leading PID line of a multi-line pid file (file-lock format contract)', async () => {
    // file-lock.ts:131-133 documents that external readers parseInt the
    // leading digits of the multi-line owner file; the token line must not
    // break PID extraction.
    await plantLock(`${String(process.pid)}\nsome-uuid-token\nmetadata line\n`);
    const check = await runLockCheck(projectRoot, true);
    expect(check.severity).toBe('ok');
  });

  it('falls back to the age gate when the pid file is absent', async () => {
    await plantLock(null);
    // Freshly created (< 60s) → not stale, no false positive on a lock a
    // concurrent process just acquired but has not written its PID into yet.
    await expect(runLockCheck(projectRoot, false)).resolves.toMatchObject({ severity: 'ok' });

    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, old, old);

    const check = await runLockCheck(projectRoot, false);
    expect(check.severity).toBe('warning');
    expect(check.message).toMatch(/no PID file and lock directory is older than 60s/);
  });
});
