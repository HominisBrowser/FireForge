// SPDX-License-Identifier: EUPL-1.2
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { PatchApplyError } from '../../errors/git.js';
import { exec } from '../../utils/process.js';
import { applyPatchIdempotent } from '../git.js';

const cleanupPaths: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function createTestRepo(prefix: string): Promise<{ repoDir: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), `fireforge-idempotent-${prefix}-`));
  cleanupPaths.push(tempDir);
  const repoDir = join(tempDir, 'engine');
  await mkdir(repoDir, { recursive: true });
  await exec('git', ['init'], { cwd: repoDir });
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  return { repoDir, tempDir };
}

async function writePatch(tempDir: string, name: string, content: string): Promise<string> {
  const patchesDir = join(tempDir, 'patches');
  await mkdir(patchesDir, { recursive: true });
  const patchPath = join(patchesDir, `${name}.patch`);
  await writeFile(patchPath, content);
  return patchPath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('applyPatchIdempotent integration', () => {
  it('applies the same patch twice without error (double-apply idempotency)', async () => {
    const { repoDir, tempDir } = await createTestRepo('double');

    await writeFile(join(repoDir, 'file.txt'), 'line 1\nline 2\nline 3\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    // Modify and capture diff
    await writeFile(join(repoDir, 'file.txt'), 'line 1\nline 2 modified\nline 3\n');
    const { stdout: diff } = await exec('git', ['diff'], { cwd: repoDir });
    await exec('git', ['checkout', '--', '.'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'mod', diff);

    // First apply
    await applyPatchIdempotent(patchPath, repoDir);
    const content1 = await readFile(join(repoDir, 'file.txt'), 'utf8');
    expect(content1).toBe('line 1\nline 2 modified\nline 3\n');

    // Second apply — should succeed via reverse→forward
    await applyPatchIdempotent(patchPath, repoDir);
    const content2 = await readFile(join(repoDir, 'file.txt'), 'utf8');
    expect(content2).toBe('line 1\nline 2 modified\nline 3\n');
  }, 30_000);

  it('preserves unrelated dirty files when re-applying', async () => {
    const { repoDir, tempDir } = await createTestRepo('unrelated');

    await writeFile(join(repoDir, 'target.txt'), 'original\n');
    await writeFile(join(repoDir, 'other.txt'), 'untouched\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    // Create patch that only touches target.txt
    await writeFile(join(repoDir, 'target.txt'), 'modified\n');
    const { stdout: diff } = await exec('git', ['diff'], { cwd: repoDir });
    await exec('git', ['checkout', '--', '.'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'target-only', diff);

    // Apply the patch
    await applyPatchIdempotent(patchPath, repoDir);

    // Dirty an unrelated file
    await writeFile(join(repoDir, 'other.txt'), 'local edits\n');

    // Re-apply — should succeed and preserve other.txt edits
    await applyPatchIdempotent(patchPath, repoDir);

    expect(await readFile(join(repoDir, 'target.txt'), 'utf8')).toBe('modified\n');
    expect(await readFile(join(repoDir, 'other.txt'), 'utf8')).toBe('local edits\n');
  }, 30_000);

  it('recovers when applied state is corrupted (reverse fails, checkout restores)', async () => {
    const { repoDir, tempDir } = await createTestRepo('corrupted');

    await writeFile(join(repoDir, 'file.txt'), 'line 1\nline 2\nline 3\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    await writeFile(join(repoDir, 'file.txt'), 'line 1\nline 2 patched\nline 3\n');
    const { stdout: diff } = await exec('git', ['diff'], { cwd: repoDir });
    await exec('git', ['checkout', '--', '.'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'mod', diff);

    // Apply once
    await applyPatchIdempotent(patchPath, repoDir);

    // Corrupt the file so reverse will fail
    await writeFile(join(repoDir, 'file.txt'), 'totally different content\n');

    // Re-apply — reverse fails, checkout HEAD restores baseline, forward apply succeeds
    await applyPatchIdempotent(patchPath, repoDir);
    expect(await readFile(join(repoDir, 'file.txt'), 'utf8')).toBe(
      'line 1\nline 2 patched\nline 3\n'
    );
  }, 30_000);

  it('handles file deletion patches idempotently', async () => {
    const { repoDir, tempDir } = await createTestRepo('delete');

    await writeFile(join(repoDir, 'doomed.txt'), 'goodbye\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    // Stage removal and capture the diff
    await exec('git', ['rm', 'doomed.txt'], { cwd: repoDir });
    const { stdout: diff } = await exec('git', ['diff', '--cached'], { cwd: repoDir });
    // Restore
    await exec('git', ['reset', 'HEAD', '--', '.'], { cwd: repoDir });
    await exec('git', ['checkout', '--', '.'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'delete', diff);

    // First apply — file is deleted
    await applyPatchIdempotent(patchPath, repoDir);
    expect(await fileExists(join(repoDir, 'doomed.txt'))).toBe(false);

    // Second apply — idempotent (reverse restores file, forward deletes again)
    await applyPatchIdempotent(patchPath, repoDir);
    expect(await fileExists(join(repoDir, 'doomed.txt'))).toBe(false);
  }, 30_000);

  it('handles new-file patches idempotently', async () => {
    const { repoDir, tempDir } = await createTestRepo('newfile');

    // Need at least one committed file for a valid repo
    await writeFile(join(repoDir, 'existing.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    // Create a new file and capture as staged diff
    await writeFile(join(repoDir, 'brand-new.txt'), 'fresh content\n');
    await exec('git', ['add', 'brand-new.txt'], { cwd: repoDir });
    const { stdout: diff } = await exec('git', ['diff', '--cached'], { cwd: repoDir });
    // Reset
    await exec('git', ['reset', 'HEAD', '--', '.'], { cwd: repoDir });
    await exec('git', ['clean', '-fd'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'newfile', diff);

    // First apply — file is created
    await applyPatchIdempotent(patchPath, repoDir);
    expect(await readFile(join(repoDir, 'brand-new.txt'), 'utf8')).toBe('fresh content\n');

    // Second apply — reverse removes it, forward creates it again
    await applyPatchIdempotent(patchPath, repoDir);
    expect(await readFile(join(repoDir, 'brand-new.txt'), 'utf8')).toBe('fresh content\n');
  }, 30_000);

  it('discards local edits to patched files when patch was never applied', async () => {
    const { repoDir, tempDir } = await createTestRepo('discard');

    await writeFile(join(repoDir, 'shared.txt'), 'line 1\nline 2\nline 3\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    // Create a patch
    await writeFile(join(repoDir, 'shared.txt'), 'line 1\nline 2 patched\nline 3\n');
    const { stdout: diff } = await exec('git', ['diff'], { cwd: repoDir });
    await exec('git', ['checkout', '--', '.'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'mod', diff);

    // Manually dirty the same file with DIFFERENT content (not applying the patch)
    await writeFile(join(repoDir, 'shared.txt'), 'my local edits\n');

    // Apply — reverse fails (never applied), checkout HEAD restores baseline,
    // forward apply succeeds. Local edits are gone.
    await applyPatchIdempotent(patchPath, repoDir);
    expect(await readFile(join(repoDir, 'shared.txt'), 'utf8')).toBe(
      'line 1\nline 2 patched\nline 3\n'
    );
  }, 30_000);

  it('throws PatchApplyError for malformed patches', async () => {
    const { repoDir, tempDir } = await createTestRepo('malformed');

    await writeFile(join(repoDir, 'file.txt'), 'content\n');
    await exec('git', ['add', '-A'], { cwd: repoDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: repoDir });

    const patchPath = await writePatch(tempDir, 'garbage', 'this is not a valid patch\n');

    await expect(applyPatchIdempotent(patchPath, repoDir)).rejects.toThrow(PatchApplyError);
  }, 30_000);
});
