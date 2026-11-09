// SPDX-License-Identifier: EUPL-1.2
import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as locks from '../../file-lock.js';
import { removeAuthoringFile } from '../../furnace-authored-lifecycle.js';
import { loadFurnaceState } from '../../furnace-config.js';
import { runFurnaceMutation } from '../../furnace-operation.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  restoreRollbackJournal,
  snapshotFile,
  trackRollbackMutations,
} from '../../furnace-rollback.js';
import { captureAuthoredSnapshot } from '../capture.js';
import {
  declareAuthoredOverride,
  removeAuthoredOverride,
  writeAuthoredSourceFile,
} from '../writer.js';
import { readCaptured, sourceFixture } from './fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(filesystem.rename).mockImplementation(original.rename);
  await Promise.all(
    directories.splice(0).map((path) => filesystem.rm(path, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
  return value;
}

function barrier(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {
    throw new Error('Barrier was not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('cooperative authored publications', () => {
  it('keeps pending publication bytes outside the captured source authority', async () => {
    const value = await fixture();
    const canonical = await filesystem.realpath(value.root);
    const paused = barrier(),
      resume = barrier();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(filesystem.rename).mockImplementation(async (from, to) => {
      if (String(to) === join(canonical, 'src/browser/new.js')) {
        paused.release();
        await resume.promise;
      }
      return original.rename(from, to);
    });
    const writer = writeAuthoredSourceFile(
      value.root,
      'browser/new.js',
      Buffer.from('unpublished replacement\n')
    );
    try {
      await Promise.race([
        paused.promise,
        writer.then(() => {
          throw new Error('Publication barrier not reached');
        }),
      ]);
      const snapshot = await captureAuthoredSnapshot({
        projectRoot: value.root,
        intendedPaths: ['src'],
        pristineRepository: value.pristine,
      });
      expect(snapshot.files.map((file) => file.path)).toEqual(['browser/new.js']);
      expect((await readCaptured(snapshot, 'browser/new.js'))?.toString()).toBe(
        'export const value = 1;\n'
      );
    } finally {
      resume.release();
      await writer;
    }
  });
  it.each([false, true])(
    'allows exactly one conditional writer through an aliased root (new file: %s)',
    async (created) => {
      const value = await fixture();
      const path = created ? 'browser/created.js' : 'browser/new.js';
      const expected = created ? null : await filesystem.readFile(join(value.root, 'src', path));
      const alias = join(dirname(value.root), 'project-alias');
      await filesystem.symlink(value.root, alias, 'dir');
      const canonical = await filesystem.realpath(value.root);
      const paused = barrier(),
        resume = barrier();
      const originalFs =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let first = true;
      vi.mocked(filesystem.rename).mockImplementation(async (from, to) => {
        if (String(to) === join(canonical, 'src', path) && first) {
          first = false;
          paused.release();
          await resume.promise;
        }
        return originalFs.rename(from, to);
      });
      const originalLock = locks.withFileLock;
      let attempts = 0;
      vi.spyOn(locks, 'withFileLock').mockImplementation((lock, operation, options) => {
        if (lock.includes('authored-writers') && ++attempts === 2) resume.release();
        return originalLock(lock, operation, options);
      });
      const winner = writeAuthoredSourceFile(value.root, path, Buffer.from('first writer\n'), {
        expected,
        mode: '100755',
      });
      await Promise.race([
        paused.promise,
        winner.then(() => {
          throw new Error('Writer completed without reaching the controlled publication barrier');
        }),
      ]);
      const contender = writeAuthoredSourceFile(alias, path, Buffer.from('second writer\n'), {
        expected,
      }).finally(resume.release);
      const results = await Promise.allSettled([winner, contender]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { message: `authored-source-moved: ${path}` },
      });
      expect(await filesystem.readFile(join(value.root, 'src', path), 'utf8')).toBe(
        'first writer\n'
      );
      expect((await filesystem.stat(join(value.root, 'src', path))).mode & 0o111).not.toBe(0);
    }
  );

  it('serializes competing first declarations rather than replacing their policy identity', async () => {
    const value = await fixture();
    const path = 'browser/manifest.txt';
    const results = await Promise.allSettled([
      declareAuthoredOverride(value.root, path, {
        component: 'first',
        classification: 'registration',
      }),
      declareAuthoredOverride(value.root, path, {
        component: 'second',
        classification: 'registration',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { message: `authored-declaration-exists: ${path}` } });
    await captureAuthoredSnapshot({
      projectRoot: value.root,
      intendedPaths: ['src'],
      pristineRepository: value.pristine,
    });
  });

  it('cannot publish through a declaration that was removed while the writer waited', async () => {
    const value = await fixture();
    const path = 'browser/manifest.txt';
    await declareAuthoredOverride(value.root, path, {
      component: 'fixture',
      classification: 'registration',
    });
    const before = await filesystem.readFile(join(value.root, 'src', path));
    const removed = barrier(),
      resume = barrier();
    const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const rawRemove = filesystem.rm;
    vi.spyOn(filesystem, 'rm').mockImplementation(async (target, options) => {
      await rawRemove(target, options);
      if (String(target).endsWith('/overrides/browser/manifest.txt.json')) {
        removed.release();
        await resume.promise;
      }
    });
    const originalLock = locks.withFileLock;
    let attempts = 0;
    vi.spyOn(locks, 'withFileLock').mockImplementation((lock, operation, options) => {
      if (lock.includes('authored-writers') && ++attempts === 2) resume.release();
      return originalLock(lock, operation, options);
    });
    const removal = removeAuthoredOverride(value.root, path);
    await removed.promise;
    const writer = writeAuthoredSourceFile(value.root, path, Buffer.from('must refuse\n'), {
      expected: before,
    }).finally(resume.release);
    const results = await Promise.allSettled([removal, writer]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    await expect(writer).rejects.toThrow('authored-declaration-required');
    await expect(originalFs.readFile(join(value.root, 'src', path))).rejects.toThrow();
  });
});

describe('conditional authored rollback', () => {
  it('keeps missing generated engine paths distinct from explicitly journaled new source files', async () => {
    const value = await fixture();
    const engine = join(value.root, 'engine/browser/generated-preview.js');
    const journal = createRollbackJournal();
    await snapshotFile(journal, engine);
    await filesystem.mkdir(dirname(engine), { recursive: true });
    await filesystem.writeFile(engine, 'generated runtime preview\n');
    await restoreRollbackJournal(journal);
    await expect(filesystem.readFile(engine)).rejects.toThrow();
    const source = join(value.root, 'src/browser/new-owned.js');
    const sourceJournal = createRollbackJournal();
    await snapshotFile(sourceJournal, source);
    await trackRollbackMutations(
      () => sourceJournal,
      () =>
        writeAuthoredSourceFile(value.root, 'browser/new-owned.js', Buffer.from('owned source\n'), {
          expected: null,
        })
    );
    await restoreRollbackJournal(sourceJournal);
    await expect(filesystem.readFile(source)).rejects.toThrow();
  });
  it('keeps rollback staging out of capture and permits an idempotent restored journal', async () => {
    const value = await fixture();
    const canonical = await filesystem.realpath(value.root);
    const journal = createRollbackJournal();
    await snapshotFile(journal, join(value.root, 'src/browser/new.js'));
    await trackRollbackMutations(
      () => journal,
      () =>
        writeAuthoredSourceFile(
          value.root,
          'browser/new.js',
          Buffer.from('owned operation image\n')
        )
    );
    const paused = barrier(),
      resume = barrier();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(filesystem.rename).mockImplementation(async (from, to) => {
      if (String(to) === join(canonical, 'src/browser/new.js')) {
        paused.release();
        await resume.promise;
      }
      return original.rename(from, to);
    });
    const rollback = restoreRollbackJournal(journal);
    try {
      await Promise.race([
        paused.promise,
        rollback.then(() => {
          throw new Error('Rollback publication barrier not reached');
        }),
      ]);
      const snapshot = await captureAuthoredSnapshot({
        projectRoot: value.root,
        intendedPaths: ['src'],
        pristineRepository: value.pristine,
      });
      expect(snapshot.files.map((file) => file.path)).toEqual(['browser/new.js']);
      expect((await readCaptured(snapshot, 'browser/new.js'))?.toString()).toBe(
        'owned operation image\n'
      );
    } finally {
      resume.release();
      await rollback;
    }
    await restoreRollbackJournal(journal);
    expect(await filesystem.readFile(join(value.root, 'src/browser/new.js'), 'utf8')).toBe(
      'export const value = 1;\n'
    );
  });
  it('persists pending repair when a failed Furnace operation cannot undo a later peer publication', async () => {
    const value = await fixture();
    const path = 'browser/new.js';
    const published = barrier(),
      resume = barrier();
    const mutation = runFurnaceMutation(value.root, 'create-rollback', async (context) => {
      const journal = createRollbackJournal();
      context.registerJournal(journal);
      await snapshotFile(journal, join(value.root, 'src', path));
      await writeAuthoredSourceFile(value.root, path, Buffer.from('operation publication\n'));
      published.release();
      await resume.promise;
      throw new Error('Intentional operation failure');
    });
    const result = Promise.allSettled([mutation]);
    await published.promise;
    await writeAuthoredSourceFile(value.root, path, Buffer.from('successful peer publication\n'), {
      expected: Buffer.from('operation publication\n'),
    });
    resume.release();
    await result;
    await expect(mutation).rejects.toThrow('Intentional operation failure');
    expect((await loadFurnaceState(value.root)).pendingRepair?.reason).toContain(
      'authored-rollback-drift'
    );
    expect(await filesystem.readFile(join(value.root, 'src', path), 'utf8')).toBe(
      'successful peer publication\n'
    );
  });
  it('preserves a completed peer write instead of restoring an older operation image', async () => {
    const value = await fixture();
    const path = 'browser/new.js';
    const journal = createRollbackJournal();
    await snapshotFile(journal, join(value.root, 'src', path));
    await trackRollbackMutations(
      () => journal,
      () => writeAuthoredSourceFile(value.root, path, Buffer.from('operation image\n'))
    );
    await writeAuthoredSourceFile(value.root, path, Buffer.from('completed peer edit\n'), {
      expected: Buffer.from('operation image\n'),
    });
    await expect(restoreRollbackJournal(journal)).rejects.toThrow('authored-rollback-drift');
    expect(await filesystem.readFile(join(value.root, 'src', path), 'utf8')).toBe(
      'completed peer edit\n'
    );
  });

  it('refuses to start an owned mutation after its journal preimage was replaced', async () => {
    const value = await fixture();
    const path = 'browser/new.js';
    const journal = createRollbackJournal();
    await snapshotFile(journal, join(value.root, 'src', path));
    await writeAuthoredSourceFile(value.root, path, Buffer.from('peer arrived first\n'));
    await expect(
      trackRollbackMutations(
        () => journal,
        () => writeAuthoredSourceFile(value.root, path, Buffer.from('stale operation\n'))
      )
    ).rejects.toThrow('authored-rollback-preimage-moved');
    expect(await filesystem.readFile(join(value.root, 'src', path), 'utf8')).toBe(
      'peer arrived first\n'
    );
  });

  it('restores an owned declaration/source pair together and preserves a later replacement pair', async () => {
    const value = await fixture();
    const path = 'browser/manifest.txt';
    await declareAuthoredOverride(value.root, path, {
      component: 'original',
      classification: 'registration',
    });
    const journal = createRollbackJournal();
    await removeAuthoringFile(join(value.root, 'src', path), journal);
    await declareAuthoredOverride(value.root, path, {
      component: 'peer',
      classification: 'registration',
    });
    await expect(restoreRollbackJournal(journal)).rejects.toThrow('authored-rollback-drift');
    expect(
      await filesystem.readFile(
        join(value.root, '.fireforge-sources/overrides', `${path}.json`),
        'utf8'
      )
    ).toContain('"component":"peer"');
    expect(await filesystem.readFile(join(value.root, 'src', path), 'utf8')).toContain('second');
  });

  it('does not recursively remove a created source directory now holding a peer file', async () => {
    const value = await fixture();
    const directory = join(value.root, 'src/browser/operation');
    await filesystem.mkdir(directory);
    const journal = createRollbackJournal();
    recordCreatedDir(journal, directory);
    await writeAuthoredSourceFile(
      value.root,
      'browser/operation/peer.js',
      Buffer.from('peer file\n'),
      { expected: null }
    );
    await restoreRollbackJournal(journal);
    expect(await filesystem.readFile(join(directory, 'peer.js'), 'utf8')).toBe('peer file\n');
  });
});
