// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exec } from '../../utils/process.js';
import { refreshOverrideFile } from '../furnace-refresh.js';

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

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd: repoDir });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const repoDir = await makeTempDir('fireforge-refresh-engine-');
  await git(repoDir, ['init']);
  await git(repoDir, ['config', 'user.email', 'test@test.com']);
  await git(repoDir, ['config', 'user.name', 'Test']);
  return repoDir;
}

async function commitAll(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ['add', '-A']);
  await git(repoDir, ['commit', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

describe('refreshOverrideFile', () => {
  it('returns unchanged when upstream content has not moved', async () => {
    const repoDir = await initRepo();
    await writeFile(join(repoDir, 'widget.css'), 'base\n');
    const baseCommit = await commitAll(repoDir, 'base');
    const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.css');
    await writeFile(overridePath, 'local edit\n');

    const result = await refreshOverrideFile({
      engineDir: repoDir,
      overridePath,
      engineRelPath: 'widget.css',
      baseCommit,
      fileName: 'widget.css',
    });

    expect(result).toEqual({ fileName: 'widget.css', status: 'unchanged' });
    await expect(readFile(overridePath, 'utf8')).resolves.toBe('local edit\n');
  });

  it('performs a clean three-way merge and writes the merged override', async () => {
    const repoDir = await initRepo();
    await writeFile(join(repoDir, 'widget.css'), 'one\nbase\nthree\n');
    const baseCommit = await commitAll(repoDir, 'base');
    await writeFile(join(repoDir, 'widget.css'), 'one\nbase\nthree upstream\n');
    await commitAll(repoDir, 'upstream');

    const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.css');
    await writeFile(overridePath, 'one local\nbase\nthree\n');

    const result = await refreshOverrideFile({
      engineDir: repoDir,
      overridePath,
      engineRelPath: 'widget.css',
      baseCommit,
      fileName: 'widget.css',
    });

    expect(result).toEqual({ fileName: 'widget.css', status: 'merged' });
    await expect(readFile(overridePath, 'utf8')).resolves.toBe('one local\nbase\nthree upstream\n');
  });

  it('reports conflicts without treating them as fatal failures', async () => {
    const repoDir = await initRepo();
    await writeFile(join(repoDir, 'widget.css'), 'value\n');
    const baseCommit = await commitAll(repoDir, 'base');
    await writeFile(join(repoDir, 'widget.css'), 'theirs\n');
    await commitAll(repoDir, 'upstream');

    const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.css');
    await writeFile(overridePath, 'ours\n');

    const result = await refreshOverrideFile({
      engineDir: repoDir,
      overridePath,
      engineRelPath: 'widget.css',
      baseCommit,
      fileName: 'widget.css',
    });

    expect(result.status).toBe('conflict');
    expect(result.conflictMarkers).toBeGreaterThan(0);
    await expect(readFile(overridePath, 'utf8')).resolves.toContain('<<<<<<<');
  });

  it('does not write merged content in dry-run mode', async () => {
    const repoDir = await initRepo();
    await writeFile(join(repoDir, 'widget.css'), 'one\nbase\nthree\n');
    const baseCommit = await commitAll(repoDir, 'base');
    await writeFile(join(repoDir, 'widget.css'), 'one\nbase\nthree upstream\n');
    await commitAll(repoDir, 'upstream');

    const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.css');
    await writeFile(overridePath, 'one local\nbase\nthree\n');

    const result = await refreshOverrideFile({
      engineDir: repoDir,
      overridePath,
      engineRelPath: 'widget.css',
      baseCommit,
      fileName: 'widget.css',
      dryRun: true,
    });

    expect(result).toEqual({ fileName: 'widget.css', status: 'merged' });
    await expect(readFile(overridePath, 'utf8')).resolves.toBe('one local\nbase\nthree\n');
  });

  it('returns new-file when the target did not exist at the base commit', async () => {
    const repoDir = await initRepo();
    await writeFile(join(repoDir, 'placeholder.txt'), 'base\n');
    const baseCommit = await commitAll(repoDir, 'base');
    await writeFile(join(repoDir, 'widget.css'), 'upstream\n');
    await commitAll(repoDir, 'upstream');

    const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.css');
    await writeFile(overridePath, 'local\n');

    await expect(
      refreshOverrideFile({
        engineDir: repoDir,
        overridePath,
        engineRelPath: 'widget.css',
        baseCommit,
        fileName: 'widget.css',
      })
    ).resolves.toEqual({ fileName: 'widget.css', status: 'new-file' });
  });

  it('returns unchanged when the upstream file was removed', async () => {
    const repoDir = await initRepo();
    await writeFile(join(repoDir, 'widget.css'), 'base\n');
    const baseCommit = await commitAll(repoDir, 'base');
    await rm(join(repoDir, 'widget.css'));
    await commitAll(repoDir, 'remove upstream');

    const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.css');
    await writeFile(overridePath, 'local\n');

    await expect(
      refreshOverrideFile({
        engineDir: repoDir,
        overridePath,
        engineRelPath: 'widget.css',
        baseCommit,
        fileName: 'widget.css',
      })
    ).resolves.toEqual({ fileName: 'widget.css', status: 'unchanged' });
  });

  // POSIX mode bits are the refusal mechanism here. NTFS ignores
  // `chmod`, so this cannot be ported to Windows, only skipped honestly.
  it.skipIf(process.platform === 'win32')(
    'preserves existing executable mode when it writes upstream content directly',
    async () => {
      const repoDir = await initRepo();
      await writeFile(join(repoDir, 'widget.sh'), 'echo base\n');
      const baseCommit = await commitAll(repoDir, 'base');
      await writeFile(join(repoDir, 'widget.sh'), 'echo upstream\n');
      await commitAll(repoDir, 'upstream');

      const overridePath = join(await makeTempDir('fireforge-refresh-override-'), 'widget.sh');
      await writeFile(overridePath, 'echo base\n');
      await chmod(overridePath, 0o755);

      await expect(
        refreshOverrideFile({
          engineDir: repoDir,
          overridePath,
          engineRelPath: 'widget.sh',
          baseCommit,
          fileName: 'widget.sh',
        })
      ).resolves.toEqual({ fileName: 'widget.sh', status: 'merged' });
      expect((await stat(overridePath)).mode & 0o777).toBe(0o755);
    }
  );
});
