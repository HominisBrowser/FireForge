// SPDX-License-Identifier: EUPL-1.2
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FurnaceError } from '../../errors/furnace.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  restoreRollbackJournal,
  restoreRollbackJournalOrThrow,
  snapshotFile,
} from '../furnace-rollback.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    void error;
    return false;
  }
}

describe('furnace rollback journal helpers', () => {
  it('creates an empty journal', () => {
    const journal = createRollbackJournal();

    expect(journal.files.size).toBe(0);
    expect(journal.createdDirs.size).toBe(0);
  });

  it('restores original file content and mode from the first snapshot only', async () => {
    const tempDir = await makeTempDir('fireforge-furnace-rollback-');
    const filePath = join(tempDir, 'component.css');
    const journal = createRollbackJournal();

    await writeFile(filePath, 'original\n');
    await chmod(filePath, 0o640);

    await snapshotFile(journal, filePath);

    await writeFile(filePath, 'mutated\n');
    await chmod(filePath, 0o600);
    await snapshotFile(journal, filePath);

    await restoreRollbackJournal(journal);

    await expect(readFile(filePath, 'utf8')).resolves.toBe('original\n');
    const restoredFileStat = await stat(filePath);
    expect(typeof restoredFileStat.mode).toBe('number');
    expect(restoredFileStat.mode & 0o777).toBe(0o640);
  });

  it('removes files that did not exist at snapshot time and cleans created directories', async () => {
    const tempDir = await makeTempDir('fireforge-furnace-rollback-');
    const nestedDir = join(tempDir, 'furnace', 'generated');
    const filePath = join(nestedDir, 'preview.css');
    const journal = createRollbackJournal();

    await snapshotFile(journal, filePath);
    recordCreatedDir(journal, nestedDir);
    recordCreatedDir(journal, join(tempDir, 'furnace'));

    await mkdir(nestedDir, { recursive: true });
    await writeFile(filePath, 'generated\n');

    await restoreRollbackJournal(journal);

    expect(await exists(filePath)).toBe(false);
    expect(await exists(nestedDir)).toBe(false);
    expect(await exists(join(tempDir, 'furnace'))).toBe(false);
  });

  it('wraps rollback failures in a FurnaceError with context', async () => {
    const tempDir = await makeTempDir('fireforge-furnace-rollback-');
    const directoryPath = join(tempDir, 'existing-directory');
    const journal = createRollbackJournal();

    await mkdir(directoryPath, { recursive: true });
    journal.files.set(directoryPath, {
      existed: true,
      content: new Uint8Array([1, 2, 3]),
      mode: 0o644,
    });

    await expect(
      restoreRollbackJournalOrThrow(journal, 'Rolling back furnace apply')
    ).rejects.toThrow(FurnaceError);
    await expect(
      restoreRollbackJournalOrThrow(journal, 'Rolling back furnace apply')
    ).rejects.toThrow(/Rolling back furnace apply; automatic rollback failed:/);
  });
});
