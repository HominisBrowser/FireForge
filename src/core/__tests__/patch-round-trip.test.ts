// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { exec } from '../../utils/process.js';

const cleanupPaths: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('patch round-trip integration', () => {
  it('export then import reproduces the same file content', async () => {
    // Set up a temp git repo simulating a mini engine
    const tempDir = await mkdtemp(join(tmpdir(), 'fireforge-patch-rt-'));
    cleanupPaths.push(tempDir);

    const engineDir = join(tempDir, 'engine');
    await mkdir(engineDir, { recursive: true });

    // Initialize a git repo with a baseline file
    await exec('git', ['init'], { cwd: engineDir });
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: engineDir });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: engineDir });

    const testFile = join(engineDir, 'test.txt');
    await writeFile(testFile, 'line 1\nline 2\nline 3\n');
    await exec('git', ['add', '-A'], { cwd: engineDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: engineDir });

    // Make a modification (simulating user changes)
    await writeFile(testFile, 'line 1\nline 2 modified\nline 3\n');

    // Export a patch via git diff
    const { stdout: diffOutput } = await exec('git', ['diff'], { cwd: engineDir });
    expect(diffOutput).toContain('line 2 modified');

    // Write the patch to disk
    const patchesDir = join(tempDir, 'patches');
    await mkdir(patchesDir, { recursive: true });
    const patchFile = join(patchesDir, '001-test.patch');
    await writeFile(patchFile, diffOutput);

    // Reset to baseline
    await exec('git', ['checkout', '--', '.'], { cwd: engineDir });

    // Verify reset
    const { stdout: resetContent } = await exec('git', ['show', 'HEAD:test.txt'], {
      cwd: engineDir,
    });
    expect(resetContent).toBe('line 1\nline 2\nline 3\n');

    // Apply the patch
    const applyResult = await exec('git', ['apply', patchFile], { cwd: engineDir });
    expect(applyResult.exitCode).toBe(0);

    // Verify the round-trip: content matches what we originally modified
    const { stdout: finalDiff } = await exec('git', ['diff'], { cwd: engineDir });
    expect(finalDiff).toContain('line 2 modified');

    // The applied diff should be identical to the exported diff
    expect(finalDiff.trim()).toBe(diffOutput.trim());
  }, 30_000);

  it('multi-file patch round-trips correctly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fireforge-patch-rt-multi-'));
    cleanupPaths.push(tempDir);

    const engineDir = join(tempDir, 'engine');
    await mkdir(engineDir, { recursive: true });

    await exec('git', ['init'], { cwd: engineDir });
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: engineDir });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: engineDir });

    // Create multiple baseline files
    await writeFile(join(engineDir, 'a.css'), 'body { color: red; }\n');
    await writeFile(join(engineDir, 'b.js'), 'console.log("hello");\n');
    await exec('git', ['add', '-A'], { cwd: engineDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: engineDir });

    // Modify both files
    await writeFile(join(engineDir, 'a.css'), 'body { color: blue; }\n');
    await writeFile(join(engineDir, 'b.js'), 'console.log("world");\n');

    // Export
    const { stdout: diffOutput } = await exec('git', ['diff'], { cwd: engineDir });

    const patchesDir = join(tempDir, 'patches');
    await mkdir(patchesDir, { recursive: true });
    const patchFile = join(patchesDir, '001-multi.patch');
    await writeFile(patchFile, diffOutput);

    // Reset
    await exec('git', ['checkout', '--', '.'], { cwd: engineDir });

    // Apply
    const applyResult = await exec('git', ['apply', patchFile], { cwd: engineDir });
    expect(applyResult.exitCode).toBe(0);

    // Verify round-trip
    const { stdout: finalDiff } = await exec('git', ['diff'], { cwd: engineDir });
    expect(finalDiff.trim()).toBe(diffOutput.trim());
  }, 30_000);

  it('new-file patch round-trips correctly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fireforge-patch-rt-new-'));
    cleanupPaths.push(tempDir);

    const engineDir = join(tempDir, 'engine');
    await mkdir(engineDir, { recursive: true });

    await exec('git', ['init'], { cwd: engineDir });
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: engineDir });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: engineDir });

    await writeFile(join(engineDir, 'existing.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: engineDir });
    await exec('git', ['commit', '-m', 'baseline'], { cwd: engineDir });

    // Add a new file
    await writeFile(join(engineDir, 'new-file.txt'), 'new content\n');
    await exec('git', ['add', 'new-file.txt'], { cwd: engineDir });

    // Export (staged diff for new files)
    const { stdout: diffOutput } = await exec('git', ['diff', '--cached'], { cwd: engineDir });
    expect(diffOutput).toContain('new file mode');

    const patchesDir = join(tempDir, 'patches');
    await mkdir(patchesDir, { recursive: true });
    const patchFile = join(patchesDir, '001-new.patch');
    await writeFile(patchFile, diffOutput);

    // Reset
    await exec('git', ['reset', 'HEAD', '--', '.'], { cwd: engineDir });
    await exec('git', ['checkout', '--', '.'], { cwd: engineDir });
    await exec('git', ['clean', '-fd'], { cwd: engineDir });

    // Apply
    const applyResult = await exec('git', ['apply', patchFile], { cwd: engineDir });
    expect(applyResult.exitCode).toBe(0);

    // Verify new file exists with correct content
    const { stdout: fileContent } = await exec('cat', ['new-file.txt'], { cwd: engineDir });
    expect(fileContent).toBe('new content\n');
  }, 30_000);
});
