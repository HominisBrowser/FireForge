// SPDX-License-Identifier: EUPL-1.2
/**
 * D13: Tests furnace behavior under file permission errors (EACCES, EPERM).
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
  };
});

import { withFileLock } from '../file-lock.js';
import {
  createRollbackJournal,
  restoreRollbackJournal,
  snapshotFile,
} from '../furnace-rollback.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  // Restore permissions before cleanup
  for (const path of cleanupPaths) {
    try {
      await chmod(path, 0o755);
    } catch {
      // Ignore: may already be gone
    }
  }
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.restoreAllMocks();
  vi.mocked(readFile).mockClear();
  vi.mocked(rename).mockClear();
  vi.mocked(writeFile).mockClear();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fireforge-test-${prefix}-`));
  cleanupPaths.push(dir);
  return dir;
}

describe('permission error handling', () => {
  // POSIX mode bits are the refusal mechanism here. NTFS ignores
  // `chmod`, so this cannot be ported to Windows, only skipped honestly.
  it.skipIf(process.platform === 'win32')(
    'file lock reports EACCES when lock directory parent is read-only',
    async () => {
      const tempDir = await makeTempDir('perm-lock');
      const lockParent = join(tempDir, 'lockdir');
      await mkdir(lockParent);

      // Make the parent read-only so mkdir for the lock fails
      await chmod(lockParent, 0o444);

      const lockPath = join(lockParent, 'subdir', 'furnace.lock');

      await expect(
        withFileLock(lockPath, () => Promise.resolve('unreachable'), {
          timeoutMs: 100,
          pollMs: 10,
        })
      ).rejects.toThrow();

      // Restore permissions for cleanup
      await chmod(lockParent, 0o755);
    }
  );

  it('refuses an unreadable snapshot without recording a false recoverable entry', async () => {
    const tempDir = await makeTempDir('perm-snapshot');
    const testFile = join(tempDir, 'test.txt');
    await writeFile(testFile, 'original content');
    const denied = Object.assign(new Error('snapshot denied'), { code: 'EACCES' });
    vi.mocked(readFile).mockRejectedValueOnce(denied);
    const journal = createRollbackJournal();
    await expect(snapshotFile(journal, testFile)).rejects.toBe(denied);
    expect(journal.files.has(testFile)).toBe(false);
    expect(await readFile(testFile, 'utf8')).toBe('original content');
  });

  it.each(['write', 'rename'] as const)(
    'continues other restores and removes temporary files when %s fails',
    async (stage) => {
      const tempDir = await makeTempDir('perm-restore');
      const blocked = join(tempDir, 'blocked.txt');
      const healthy = join(tempDir, 'healthy.txt');
      await writeFile(blocked, 'original blocked');
      await writeFile(healthy, 'original healthy');
      const journal = createRollbackJournal();
      await snapshotFile(journal, blocked);
      await snapshotFile(journal, healthy);
      await writeFile(blocked, 'modified blocked');
      await writeFile(healthy, 'modified healthy');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const denied = Object.assign(new Error(`${stage} denied`), { code: 'EACCES' });
      if (stage === 'write') {
        vi.mocked(writeFile).mockImplementation((path, data, options) =>
          typeof path === 'string' && path.startsWith(`${blocked}.rollback-`)
            ? Promise.reject(denied)
            : actual.writeFile(path, data, options)
        );
      } else {
        vi.mocked(rename).mockImplementation((source, destination) =>
          destination === blocked ? Promise.reject(denied) : actual.rename(source, destination)
        );
      }
      try {
        await expect(restoreRollbackJournal(journal)).rejects.toThrow(`${stage} denied`);
        expect(await readFile(blocked, 'utf8')).toBe('modified blocked');
        expect(await readFile(healthy, 'utf8')).toBe('original healthy');
        expect((await readdir(tempDir)).filter((name) => name.includes('.rollback-'))).toEqual([]);
        if (stage === 'rename') {
          expect(rename).toHaveBeenCalledWith(
            expect.stringContaining(`${blocked}.rollback-`),
            blocked
          );
        }
      } finally {
        vi.mocked(writeFile).mockImplementation(actual.writeFile);
        vi.mocked(rename).mockImplementation(actual.rename);
      }
    }
  );
});
