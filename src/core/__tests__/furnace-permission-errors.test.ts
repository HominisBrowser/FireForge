// SPDX-License-Identifier: EUPL-1.2
/**
 * D13: Tests furnace behavior under file permission errors (EACCES, EPERM).
 */
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

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
      // Ignore — may already be gone
    }
  }
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fireforge-test-${prefix}-`));
  cleanupPaths.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('permission error handling', () => {
  // POSIX mode bits are the refusal mechanism here; NTFS ignores
  // `chmod`, so this cannot be ported to Windows — only skipped honestly.
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

  it('rollback journal snapshot handles files that become unreadable', async () => {
    const tempDir = await makeTempDir('perm-snapshot');
    const testFile = join(tempDir, 'test.txt');
    await writeFile(testFile, 'original content');

    const journal = createRollbackJournal();
    await snapshotFile(journal, testFile);

    // Overwrite the file
    await writeFile(testFile, 'modified content');

    // Restore should work since we have the snapshot
    await restoreRollbackJournal(journal);

    const { readFile } = await import('node:fs/promises');
    const restoredContent = await readFile(testFile, 'utf-8');
    expect(restoredContent).toBe('original content');
  });

  it('rollback journal restores files even when some writes fail', async () => {
    const tempDir = await makeTempDir('perm-restore');
    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    await writeFile(file1, 'content1');
    await writeFile(file2, 'content2');

    const journal = createRollbackJournal();
    await snapshotFile(journal, file1);
    await snapshotFile(journal, file2);

    // Modify both files
    await writeFile(file1, 'modified1');
    await writeFile(file2, 'modified2');

    // Restore should succeed for both
    await restoreRollbackJournal(journal);

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(file1, 'utf-8')).toBe('content1');
    expect(await readFile(file2, 'utf-8')).toBe('content2');
  });

  // POSIX mode bits are the refusal mechanism here; NTFS ignores
  // `chmod`, so this cannot be ported to Windows — only skipped honestly.
  it.skipIf(process.platform === 'win32')(
    'snapshot captures file mode and restores it',
    async () => {
      const tempDir = await makeTempDir('perm-mode');
      const testFile = join(tempDir, 'executable.sh');
      await writeFile(testFile, '#!/bin/bash\necho hello');
      await chmod(testFile, 0o755);

      const journal = createRollbackJournal();
      await snapshotFile(journal, testFile);

      // Overwrite with different content and mode
      await writeFile(testFile, 'overwritten');
      await chmod(testFile, 0o644);

      await restoreRollbackJournal(journal);

      const { readFile, stat } = await import('node:fs/promises');
      expect(await readFile(testFile, 'utf-8')).toBe('#!/bin/bash\necho hello');
      const stats = await stat(testFile);
      // Check executable bit is restored (at least owner execute)
      expect(stats.mode & 0o100).toBe(0o100);
    }
  );

  it('snapshot of nonexistent file causes deletion on restore', async () => {
    const tempDir = await makeTempDir('perm-nonexist');
    const testFile = join(tempDir, 'new-file.txt');

    const journal = createRollbackJournal();
    // Snapshot a file that does not exist yet
    await snapshotFile(journal, testFile);

    // Create the file (simulating a mutation that adds it)
    await writeFile(testFile, 'new content');
    expect(await exists(testFile)).toBe(true);

    // Restore should delete the file
    await restoreRollbackJournal(journal);
    expect(await exists(testFile)).toBe(false);
  });
});
