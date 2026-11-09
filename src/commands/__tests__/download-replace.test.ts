// SPDX-License-Identifier: EUPL-1.2
/** The checks and the swap behind `download --force`, against real directories and real Git. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateMock = vi.hoisted(() => vi.fn());
const manifestMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), verbose: vi.fn() }));

const renameMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});
vi.mock('../../core/config.js', () => ({ loadState: stateMock }));
vi.mock('../../core/patch-manifest.js', () => ({ loadPatchesManifest: manifestMock }));
vi.mock('../../utils/logger.js', () => loggerMock);

import {
  activateReplacementEngine,
  describeForcedReplacementLoss,
  forcedReplacementFingerprint,
  getPatchTouchedFiles,
  restorePreviousEngine,
} from '../download-replace.js';

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-download-replace-'));
  directories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }
  ).trim();
}

/** A repository with one committed file and its HEAD. */
async function engineWithCommit(): Promise<{ dir: string; head: string }> {
  const dir = join(await scratch(), 'engine');
  await mkdir(dir);
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'tracked.txt'), 'tracked\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

beforeEach(() => {
  stateMock.mockReset().mockResolvedValue({});
  manifestMock.mockReset().mockResolvedValue(null);
  loggerMock.warn.mockReset();
  loggerMock.verbose.mockReset();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await chmod(path, 0o755).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe('getPatchTouchedFiles', () => {
  it('is empty when the patches directory is absent', async () => {
    const root = await scratch();
    expect(await getPatchTouchedFiles(join(root, 'patches'))).toEqual(new Set());
    expect(manifestMock).not.toHaveBeenCalled();
  });

  it('is empty when the manifest is missing or lists no patches', async () => {
    const root = await scratch();
    expect(await getPatchTouchedFiles(root)).toEqual(new Set());
    manifestMock.mockResolvedValue({ patches: [] });
    expect(await getPatchTouchedFiles(root)).toEqual(new Set());
  });

  it('collects every file any patch affects', async () => {
    const root = await scratch();
    manifestMock.mockResolvedValue({
      patches: [{ filesAffected: ['a.txt', 'dir/b.txt'] }, { filesAffected: ['a.txt', 'c.txt'] }],
    });
    expect(await getPatchTouchedFiles(root)).toEqual(new Set(['a.txt', 'dir/b.txt', 'c.txt']));
  });
});

describe('describeForcedReplacementLoss', () => {
  it('reports no loss for an engine that is not a git repository', async () => {
    const root = await scratch();
    expect(await describeForcedReplacementLoss(join(root, 'engine'), root, undefined)).toBe(
      undefined
    );
  });

  it('reports no loss for a repository with no commit yet', async () => {
    const dir = join(await scratch(), 'engine');
    await mkdir(dir);
    git(dir, 'init', '-q');
    expect(await describeForcedReplacementLoss(dir, dir, 'a'.repeat(40))).toBeUndefined();
  });

  it('reports no loss for a clean engine at the recorded base, or with no recorded base', async () => {
    const { dir, head } = await engineWithCommit();
    expect(await describeForcedReplacementLoss(dir, dir, head)).toBeUndefined();
    expect(await describeForcedReplacementLoss(dir, dir, undefined)).toBeUndefined();
  });

  it('counts paths that match the patch queue apart from unexported work', async () => {
    const { dir } = await engineWithCommit();
    await mkdir(join(dir, 'queued-dir'));
    await writeFile(join(dir, 'queued-dir', 'x.txt'), 'x');
    await writeFile(join(dir, 'tracked.txt'), 'edited\n');
    await writeFile(join(dir, 'stray.txt'), 'stray');
    manifestMock.mockResolvedValue({
      patches: [{ filesAffected: ['tracked.txt', 'queued-dir/x.txt'] }],
    });
    const message = await describeForcedReplacementLoss(dir, dir, undefined);
    expect(message).toContain('3 changed path(s)');
    expect(message).toContain('2 match the patch queue, 1 do not (unexported work');
    expect(message).toContain('--force replaces the whole directory.');
  });

  it('ends the sentence plainly when every changed path is in the queue', async () => {
    const { dir } = await engineWithCommit();
    await writeFile(join(dir, 'tracked.txt'), 'edited\n');
    manifestMock.mockResolvedValue({ patches: [{ filesAffected: ['tracked.txt'] }] });
    const message = await describeForcedReplacementLoss(dir, dir, undefined);
    expect(message).toContain('1 match the patch queue, 0 do not.');
  });

  it('reports a HEAD that moved off the recorded base even when the tree is clean', async () => {
    const { dir, head } = await engineWithCommit();
    await writeFile(join(dir, 'tracked.txt'), 'second\n');
    git(dir, 'commit', '-qam', 'second');
    const message = await describeForcedReplacementLoss(dir, dir, head);
    expect(message).toContain(`is not the recorded base commit ${head.slice(0, 12)}`);
    expect(message).not.toContain('changed path(s)');
  });

  it('rethrows a git failure that is not a missing HEAD', async () => {
    const { dir } = await engineWithCommit();
    await writeFile(join(dir, '.git', 'HEAD'), 'garbage\n');
    await expect(describeForcedReplacementLoss(dir, dir, undefined)).rejects.toThrow();
  });
});

describe('forcedReplacementFingerprint', () => {
  it('distinguishes an absent engine, a plain directory and an unborn HEAD', async () => {
    const root = await scratch();
    stateMock.mockResolvedValue({ baseCommit: 'base' });
    const absent = JSON.parse(
      await forcedReplacementFingerprint(join(root, 'engine'), root)
    ) as unknown;
    expect(absent).toEqual({ engine: 'absent', baseCommit: 'base' });

    const plain = join(root, 'plain');
    await mkdir(plain);
    expect(JSON.parse(await forcedReplacementFingerprint(plain, root))).toEqual({
      engine: 'not-git',
      baseCommit: 'base',
    });

    const unborn = join(root, 'unborn');
    await mkdir(unborn);
    git(unborn, 'init', '-q');
    expect(JSON.parse(await forcedReplacementFingerprint(unborn, root))).toEqual({
      engine: 'no-head',
      baseCommit: 'base',
    });
  });

  it('changes when HEAD, or the working tree, changes, and not otherwise', async () => {
    const { dir, head } = await engineWithCommit();
    const clean = await forcedReplacementFingerprint(dir, dir);
    expect(JSON.parse(clean)).toMatchObject({ engine: 'git', head, entries: [] });
    expect(await forcedReplacementFingerprint(dir, dir)).toBe(clean);

    await writeFile(join(dir, 'new.txt'), 'new');
    const dirty = await forcedReplacementFingerprint(dir, dir);
    expect(dirty).not.toBe(clean);
    expect((JSON.parse(dirty) as { entries: string[] }).entries).toEqual(['?? new.txt']);

    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'second');
    const moved = await forcedReplacementFingerprint(dir, dir);
    expect((JSON.parse(moved) as { head: string }).head).not.toBe(head);
    expect(moved).not.toBe(dirty);
  });

  it('rethrows a git failure that is not a missing HEAD', async () => {
    const { dir } = await engineWithCommit();
    await writeFile(join(dir, '.git', 'HEAD'), 'garbage\n');
    await expect(forcedReplacementFingerprint(dir, dir)).rejects.toThrow();
  });
});

async function swapFixture(): Promise<{
  root: string;
  engineDir: string;
  replacementDir: string;
  backupDir: string;
}> {
  const root = await scratch();
  const engineDir = join(root, 'engine');
  const replacementDir = join(root, 'engine.new');
  const backupDir = join(root, 'engine.old');
  await mkdir(engineDir);
  await writeFile(join(engineDir, 'marker'), 'previous');
  await mkdir(replacementDir);
  await writeFile(join(replacementDir, 'marker'), 'replacement');
  return { root, engineDir, replacementDir, backupDir };
}

describe('activateReplacementEngine', () => {
  it('moves engine/ aside and the replacement into place', async () => {
    const paths = await swapFixture();
    await activateReplacementEngine(paths);
    expect(await readFile(join(paths.engineDir, 'marker'), 'utf8')).toBe('replacement');
    expect(await readFile(join(paths.backupDir, 'marker'), 'utf8')).toBe('previous');
    expect(existsSync(paths.replacementDir)).toBe(false);
  });

  it('restores the previous engine when the replacement cannot be moved in', async () => {
    const paths = await swapFixture();
    await rm(paths.replacementDir, { recursive: true });
    await expect(activateReplacementEngine(paths)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(paths.engineDir, 'marker'), 'utf8')).toBe('previous');
    expect(existsSync(paths.backupDir)).toBe(false);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('says where the backup is when the restore fails too, and still throws the swap error', async () => {
    const paths = await swapFixture();
    await rm(paths.replacementDir, { recursive: true });
    const swapError = Object.assign(new Error('swap failed'), { code: 'EXDEV' });
    renameMock.mockImplementationOnce(async (from: string, to: string) => {
      const { rename } =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await rename(from, to);
    });
    renameMock
      .mockRejectedValueOnce(swapError)
      .mockRejectedValueOnce(Object.assign(new Error('restore failed'), { code: 'EBUSY' }));
    await expect(activateReplacementEngine(paths)).rejects.toBe(swapError);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Previous engine backup remains at ${paths.backupDir}`)
    );
    expect(loggerMock.verbose).toHaveBeenCalledWith(
      expect.stringContaining('Engine restore failure detail: restore failed')
    );
  });

  it('does not touch anything when engine/ cannot be moved aside', async () => {
    const paths = await swapFixture();
    await rm(paths.engineDir, { recursive: true });
    await expect(activateReplacementEngine(paths)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(paths.replacementDir, 'marker'), 'utf8')).toBe('replacement');
  });
});

describe('restorePreviousEngine', () => {
  it('replaces the failed engine/ with the backup', async () => {
    const paths = await swapFixture();
    await activateReplacementEngine(paths);
    await restorePreviousEngine({ ...paths, reason: new Error('build failed') });
    expect(await readFile(join(paths.engineDir, 'marker'), 'utf8')).toBe('previous');
    expect(existsSync(paths.backupDir)).toBe(false);
    expect(loggerMock.verbose).toHaveBeenCalledWith(expect.stringContaining('build failed'));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('Restored the previous'));
  });

  it('accepts a non-Error reason', async () => {
    const paths = await swapFixture();
    await activateReplacementEngine(paths);
    await restorePreviousEngine({ ...paths, reason: 'plain string' });
    expect(loggerMock.verbose).toHaveBeenCalledWith(expect.stringContaining('plain string'));
  });

  it('points at the backup instead of throwing when it cannot be moved back', async () => {
    const paths = await swapFixture();
    await activateReplacementEngine(paths);
    await rm(paths.backupDir, { recursive: true });
    await restorePreviousEngine({ ...paths, reason: new Error('failed') });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Previous engine backup remains at ${paths.backupDir}`)
    );
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Restored the previous')
    );
    expect(loggerMock.verbose).toHaveBeenCalledWith(
      expect.stringContaining('Engine restore failure detail:')
    );
  });
});
