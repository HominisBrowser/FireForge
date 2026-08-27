// SPDX-License-Identifier: EUPL-1.2
/**
 * D14: Tests that furnace correctly handles symlinks during rollback
 * and component operations (symlinks should be skipped, not followed).
 */
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { createRollbackJournal, restoreRollbackJournal, snapshotDir } from '../furnace-rollback.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
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

describe('symlink handling in rollback', () => {
  it('snapshotDir skips symlinks and does not follow them', async () => {
    const tempDir = await makeTempDir('symlink-skip');
    const componentDir = join(tempDir, 'component');
    const targetDir = join(tempDir, 'target');

    await mkdir(componentDir);
    await mkdir(targetDir);

    // Create a real file and a symlink in the component directory
    await writeFile(join(componentDir, 'real.mjs'), 'export default class {}');
    await writeFile(join(targetDir, 'linked-target.txt'), 'target content');
    await symlink(join(targetDir, 'linked-target.txt'), join(componentDir, 'linked.txt'));

    const journal = createRollbackJournal();
    await snapshotDir(journal, componentDir);

    // Modify both the real file and the symlink target
    await writeFile(join(componentDir, 'real.mjs'), 'export default class Modified {}');
    await writeFile(join(targetDir, 'linked-target.txt'), 'modified target');

    // Restore should fix the real file but not touch the symlink target
    await restoreRollbackJournal(journal);

    const realContent = await readFile(join(componentDir, 'real.mjs'), 'utf-8');
    expect(realContent).toBe('export default class {}');

    // The symlink itself should still exist and point to the target
    const linkTarget = await readlink(join(componentDir, 'linked.txt'));
    expect(linkTarget).toBe(join(targetDir, 'linked-target.txt'));

    // The target content should NOT have been restored (symlinks are skipped)
    const targetContent = await readFile(join(targetDir, 'linked-target.txt'), 'utf-8');
    expect(targetContent).toBe('modified target');
  });

  it('snapshotDir handles directories containing only symlinks', async () => {
    const tempDir = await makeTempDir('symlink-only');
    const componentDir = join(tempDir, 'component');
    const targetDir = join(tempDir, 'target');

    await mkdir(componentDir);
    await mkdir(targetDir);

    await writeFile(join(targetDir, 'a.txt'), 'content a');
    await symlink(join(targetDir, 'a.txt'), join(componentDir, 'link-a.txt'));

    const journal = createRollbackJournal();
    // Should not throw when directory contains only symlinks
    await snapshotDir(journal, componentDir);

    // Restore should complete without errors
    await restoreRollbackJournal(journal);

    // Symlink should still exist
    const linkTarget = await readlink(join(componentDir, 'link-a.txt'));
    expect(linkTarget).toBe(join(targetDir, 'a.txt'));
  });

  it('snapshotDir does not traverse symlinked directories', async () => {
    const tempDir = await makeTempDir('symlink-dir');
    const componentDir = join(tempDir, 'component');
    const deepDir = join(tempDir, 'deep');

    await mkdir(componentDir);
    await mkdir(deepDir);

    await writeFile(join(componentDir, 'root.css'), ':host { display: block; }');
    await writeFile(join(deepDir, 'secret.txt'), 'should not be snapshotted');
    await symlink(deepDir, join(componentDir, 'symlinked-subdir'));

    const journal = createRollbackJournal();
    await snapshotDir(journal, componentDir);

    // Modify the deep file
    await writeFile(join(deepDir, 'secret.txt'), 'modified secret');

    // Modify the real file
    await writeFile(join(componentDir, 'root.css'), ':host { display: flex; }');

    await restoreRollbackJournal(journal);

    // Real file should be restored
    const cssContent = await readFile(join(componentDir, 'root.css'), 'utf-8');
    expect(cssContent).toBe(':host { display: block; }');

    // Deep file should NOT be restored (symlinked directory was skipped)
    const deepContent = await readFile(join(deepDir, 'secret.txt'), 'utf-8');
    expect(deepContent).toBe('modified secret');
  });
});
