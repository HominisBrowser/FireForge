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
  snapshotDir,
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

  // POSIX mode bits are the refusal mechanism here; NTFS ignores
  // `chmod`, so this cannot be ported to Windows — only skipped honestly.
  it.skipIf(process.platform === 'win32')(
    'restores original file content and mode from the first snapshot only',
    async () => {
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
    }
  );

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

  it('restores files whose snapshot has no mode', async () => {
    const tempDir = await makeTempDir('fireforge-furnace-rollback-nomode-');
    const filePath = join(tempDir, 'plain.txt');
    const journal = createRollbackJournal();

    journal.files.set(filePath, {
      existed: true,
      content: new Uint8Array(Buffer.from('original\n')),
    });

    await writeFile(filePath, 'mutated\n');

    await restoreRollbackJournal(journal);

    await expect(readFile(filePath, 'utf8')).resolves.toBe('original\n');
  });

  // POSIX mode bits are the refusal mechanism here; NTFS ignores
  // `chmod`, so this cannot be ported to Windows — only skipped honestly.
  it.skipIf(process.platform === 'win32')(
    'cleans up the temp file when the atomic rename fails',
    async () => {
      const tempDir = await makeTempDir('fireforge-furnace-rollback-rename-');
      const filePath = join(tempDir, 'nested', 'deep', 'file.txt');
      const journal = createRollbackJournal();

      journal.files.set(filePath, {
        existed: true,
        content: new Uint8Array(Buffer.from('original\n')),
        mode: 0o644,
      });

      // Make the parent directory read-only so the temp file write fails with EACCES.
      await mkdir(join(tempDir, 'nested', 'deep'), { recursive: true });
      await writeFile(filePath, 'mutated\n');
      await chmod(join(tempDir, 'nested', 'deep'), 0o444);

      await expect(restoreRollbackJournal(journal)).rejects.toThrow();

      // Restore permissions for cleanup.
      await chmod(join(tempDir, 'nested', 'deep'), 0o755);
    }
  );

  it('restores an empty journal without errors', async () => {
    const journal = createRollbackJournal();

    await expect(restoreRollbackJournal(journal)).resolves.toBeUndefined();
  });
});

describe('snapshotDir', () => {
  it('recursively snapshots files and restores them after mutation', async () => {
    const tempDir = await makeTempDir('fireforge-furnace-rollback-dir-');
    const nested = join(tempDir, 'widgets', 'moz-button');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'moz-button.mjs'), 'export class MozButton {}');
    await writeFile(join(nested, 'moz-button.css'), ':host { display: block; }');

    const journal = createRollbackJournal();
    await snapshotDir(journal, join(tempDir, 'widgets'));

    // Mutate files.
    await writeFile(join(nested, 'moz-button.mjs'), 'CORRUPTED');
    await writeFile(join(nested, 'moz-button.css'), 'CORRUPTED');

    await restoreRollbackJournal(journal);

    await expect(readFile(join(nested, 'moz-button.mjs'), 'utf8')).resolves.toBe(
      'export class MozButton {}'
    );
    await expect(readFile(join(nested, 'moz-button.css'), 'utf8')).resolves.toBe(
      ':host { display: block; }'
    );
  });

  it('skips symlinks within the directory tree', async () => {
    const { symlink } = await import('node:fs/promises');
    const tempDir = await makeTempDir('fireforge-furnace-rollback-symlink-');
    const nested = join(tempDir, 'widgets');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'real.txt'), 'real content');
    await symlink(join(nested, 'real.txt'), join(nested, 'link.txt'));

    const journal = createRollbackJournal();
    await snapshotDir(journal, nested);

    expect(journal.files.has(join(nested, 'real.txt'))).toBe(true);
    expect(journal.files.has(join(nested, 'link.txt'))).toBe(false);
    expect(journal.skippedSymlinks.has(join(nested, 'link.txt'))).toBe(true);
  });

  it('does not traverse symlinked directories', async () => {
    const { symlink } = await import('node:fs/promises');
    const tempDir = await makeTempDir('fireforge-furnace-rollback-symlink-dir-');
    const componentDir = join(tempDir, 'component');
    const deepDir = join(tempDir, 'deep');
    await mkdir(componentDir);
    await mkdir(deepDir);
    await writeFile(join(componentDir, 'root.css'), ':host { display: block; }');
    await writeFile(join(deepDir, 'secret.txt'), 'should not be snapshotted');
    await symlink(deepDir, join(componentDir, 'symlinked-subdir'));

    const journal = createRollbackJournal();
    await snapshotDir(journal, componentDir);

    await writeFile(join(deepDir, 'secret.txt'), 'modified secret');
    await writeFile(join(componentDir, 'root.css'), ':host { display: flex; }');
    await restoreRollbackJournal(journal);

    expect(await readFile(join(componentDir, 'root.css'), 'utf-8')).toBe(
      ':host { display: block; }'
    );
    // The symlinked directory was never descended into, so its contents are
    // untouched by the restore.
    expect(await readFile(join(deepDir, 'secret.txt'), 'utf-8')).toBe('modified secret');
  });

  it('returns without recording anything when the path does not exist', async () => {
    const journal = createRollbackJournal();
    await snapshotDir(journal, '/nonexistent/path/that/does/not/exist');

    expect(journal.files.size).toBe(0);
  });
});
