// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureAuthoredSnapshot } from '../capture.js';
import { generateAuthoredDelta } from '../generate.js';
import { sourceGit } from '../git.js';
import {
  exportCapturedTree,
  exportPristineTree,
  materializeAuthoredSnapshot,
} from '../materialize.js';
import { authenticateAuthoredSnapshot } from '../provider.js';
import { readCaptured, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(): Promise<Awaited<ReturnType<typeof sourceFixture>>> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  return value;
}

describe('authored captured source', () => {
  it('captures dirty bytes, new binary files, executable modes, root config and deletes without touching the index or HEAD', async () => {
    const { root, pristine } = await fixture();
    const head = await sourceGit(root, ['rev-parse', 'HEAD']);
    const index = await readFile(join(root, '.git/index'));
    await rm(join(root, 'src/browser/new.js'));
    await writeAt(root, 'src/browser/binary.bin', Buffer.from([0, 0xff, 10]));
    await writeAt(root, 'src/browser/run.sh', '#!/bin/sh\nexit 0\n', true);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'browser/binary.bin',
      'browser/run.sh',
    ]);
    expect(snapshot.files[1]?.mode).toBe('100755');
    expect(await readCaptured(snapshot, 'browser/binary.bin')).toEqual(Buffer.from([0, 0xff, 10]));
    expect(await sourceGit(root, ['rev-parse', 'HEAD'])).toEqual(head);
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    await writeAt(root, 'src/browser/run.sh', 'changed after capture\n');
    expect((await readCaptured(snapshot, 'browser/run.sh'))?.toString()).toContain('exit 0');
    const next = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    expect(next.id).not.toBe(snapshot.id);
  });

  it('refuses symlinks and unapproved upstream shadows, authenticates sidecar blobs and pin before accepting a merged tree', async () => {
    const { root, pristine, declaration } = await fixture();
    await writeAt(root, 'src/browser/manifest.txt', 'local\n');
    await expect(
      captureAuthoredSnapshot({
        projectRoot: root,
        intendedPaths: ['src'],
        pristineRepository: pristine,
      })
    ).rejects.toThrow('authored-shadows-upstream');
    const sidecar = '.fireforge-sources/overrides/browser/manifest.txt.json';
    await writeAt(
      root,
      sidecar,
      JSON.stringify({ ...declaration, base: { ...declaration.base, blob: 'f'.repeat(40) } })
    );
    await expect(
      captureAuthoredSnapshot({
        projectRoot: root,
        intendedPaths: ['src'],
        pristineRepository: pristine,
      })
    ).rejects.toThrow('override-base-mismatch');
    await writeAt(
      root,
      sidecar,
      JSON.stringify({ ...declaration, base: { ...declaration.base, pin: 'b'.repeat(64) } })
    );
    await expect(
      captureAuthoredSnapshot({
        projectRoot: root,
        intendedPaths: ['src'],
        pristineRepository: pristine,
      })
    ).rejects.toThrow('override-base-stale');
    await writeAt(root, sidecar, JSON.stringify(declaration));
    await symlink(join(root, 'package.json'), join(root, 'src/link.js'));
    await expect(
      captureAuthoredSnapshot({
        projectRoot: root,
        intendedPaths: ['src'],
        pristineRepository: pristine,
      })
    ).rejects.toThrow('authored-symlink');
  });

  it('authenticates serialized snapshots and exports only frozen tracked inputs', async () => {
    const { root, pristine } = await fixture();
    await writeAt(root, 'secrets/password', 'must not export');
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    await expect(
      authenticateAuthoredSnapshot({ ...snapshot, files: [] }, pristine)
    ).rejects.toThrow('authored-snapshot-mismatch');
    const output = join(dirname(root), 'export');
    await exportCapturedTree(snapshot, output);
    expect(await readFile(join(output, 'src/browser/new.js'), 'utf8')).toContain('value = 1');
    await expect(readFile(join(output, 'secrets/password'))).rejects.toThrow();
  });

  it('refuses a handle whose unused tracked root input is no longer available in its object store', async () => {
    const { root, pristine } = await fixture();
    await writeAt(
      root,
      'tools/captured-input.txt',
      'This root input is not read by source classification.\n'
    );
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src', 'tools'],
      pristineRepository: pristine,
    });
    const blob = snapshot.inputs.find((input) => input.path === 'tools/captured-input.txt')?.blob;
    if (!blob) throw new Error('Fixture root input was not captured');
    await rm(join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    const handle: unknown = JSON.parse(JSON.stringify(snapshot));
    await expect(authenticateAuthoredSnapshot(handle, pristine)).rejects.toThrow(
      'authored-object-unavailable'
    );
  });
});

describe('authored generation and materialization', () => {
  it('generates replayable deterministic text/binary/mode diffs despite hostile Git configuration', async () => {
    const { root, pristine, declaration } = await fixture();
    await writeAt(root, 'src/browser/manifest.txt', 'first\nchanged\nthird\nfourth\nfifth\n');
    await writeAt(
      root,
      '.fireforge-sources/overrides/browser/manifest.txt.json',
      JSON.stringify(declaration)
    );
    await writeAt(root, 'src/browser/data.bin', Buffer.from([0, 0xff, 10]));
    await writeAt(root, 'src/browser/latin.txt', Buffer.from([0xff, 0xfe, 10]));
    await chmod(join(root, 'src/browser/new.js'), 0o755);
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    const delta = await generateAuthoredDelta(snapshot, { pristineRepository: pristine });
    await sourceGit(root, ['config', 'diff.algorithm', 'histogram']);
    await sourceGit(root, ['config', 'diff.noprefix', 'true']);
    await sourceGit(root, ['config', 'core.autocrlf', 'true']);
    expect(await generateAuthoredDelta(snapshot, { pristineRepository: pristine })).toBe(delta);
    expect(delta).toContain('GIT binary patch');
    expect(delta).toContain('new file mode 100755');
    const replay = join(dirname(root), 'replay');
    await exportPristineTree(pristine, snapshot.pin.commit, replay);
    await sourceGit(replay, ['init', '-q']);
    await sourceGit(replay, ['apply', '--binary', '-'], delta);
    expect(await readFile(join(replay, 'browser/data.bin'))).toEqual(Buffer.from([0, 0xff, 10]));
    expect(await readFile(join(replay, 'browser/latin.txt'))).toEqual(
      Buffer.from([0xff, 0xfe, 10])
    );
    expect(await readFile(join(replay, 'browser/manifest.txt'), 'utf8')).toContain('changed');
    expect((await stat(join(replay, 'browser/new.js'))).mode & 0o111).not.toBe(0);
  });

  it('delta-materializes exact bytes, refuses dirty outputs, restores removed overrides and deletes removed creations', async () => {
    const { root, pristine, declaration } = await fixture();
    await writeAt(root, 'src/browser/manifest.txt', 'local\n');
    const sidecar = '.fireforge-sources/overrides/browser/manifest.txt.json';
    await writeAt(root, sidecar, JSON.stringify(declaration));
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    const output = join(dirname(root), 'runtime');
    const ledgerPath = join(dirname(root), 'ledger.json');
    await exportPristineTree(pristine, snapshot.pin.commit, output);
    const args = { snapshot, engineDir: output, ledgerPath, pristineRepository: pristine };
    const result = await materializeAuthoredSnapshot(args);
    expect(result.changed).toEqual(['browser/manifest.txt', 'browser/new.js']);
    expect((await materializeAuthoredSnapshot(args)).changed).toEqual([]);
    await writeAt(output, 'browser/new.js', 'foreign\n');
    await expect(materializeAuthoredSnapshot(args)).rejects.toThrow('authored-engine-drift');
    await writeAt(output, 'browser/new.js', 'export const value = 1;\n');
    await rm(join(root, 'src/browser/manifest.txt'));
    await rm(join(root, sidecar));
    await rm(join(root, 'src/browser/new.js'));
    const removed = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    const update = await materializeAuthoredSnapshot({ ...args, snapshot: removed });
    expect(update.restored).toEqual(['browser/manifest.txt']);
    expect(await readFile(join(output, 'browser/manifest.txt'), 'utf8')).toContain('second');
    await expect(readFile(join(output, 'browser/new.js'))).rejects.toThrow();
  });

  it('requires explicit upstream tombstones and restores their pristine files when removed', async () => {
    const { root, pristine, declaration } = await fixture();
    const sidecar = '.fireforge-sources/overrides/browser/manifest.txt.json';
    await writeAt(root, sidecar, JSON.stringify({ ...declaration, kind: 'delete' }));
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: root,
      intendedPaths: ['src'],
      pristineRepository: pristine,
    });
    const output = join(dirname(root), 'runtime');
    await exportPristineTree(pristine, snapshot.pin.commit, output);
    const args = {
      snapshot,
      engineDir: output,
      ledgerPath: join(dirname(root), 'ledger.json'),
      pristineRepository: pristine,
    };
    await materializeAuthoredSnapshot(args);
    await expect(readFile(join(output, 'browser/manifest.txt'))).rejects.toThrow();
    await rm(join(root, sidecar));
    await materializeAuthoredSnapshot({
      ...args,
      snapshot: await captureAuthoredSnapshot({
        projectRoot: root,
        intendedPaths: ['src'],
        pristineRepository: pristine,
      }),
    });
    expect(await readFile(join(output, 'browser/manifest.txt'), 'utf8')).toContain('second');
  });
});
