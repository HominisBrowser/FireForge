// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { captureAuthoredSnapshot } from '../capture.js';
import { type ExportEntry, verifyExportedTree } from '../export-tree.js';
import { parseSourceTreeRecords, sourceGit } from '../git.js';
import {
  exportCapturedTree,
  exportPristineTree,
  materializeAuthoredSnapshot,
} from '../materialize.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function entriesOf(repository: string, commit: string): Promise<ExportEntry[]> {
  return parseSourceTreeRecords(
    await sourceGit(repository, ['ls-tree', '-r', '-z', '--full-tree', commit])
  ).map((record) => ({ path: record.path, mode: record.mode, blob: record.oid }));
}

/** Everything in-tree attributes could rewrite or drop, and every kind a pristine tree holds. */
async function hostilePristine(): Promise<{ root: string; pristine: string; commit: string }> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await writeAt(
    value.pristine,
    '.gitattributes',
    [
      '*.subst export-subst',
      '*.dropped export-ignore',
      '*.ident ident',
      '*.crlf text eol=crlf',
      '*.auto text=auto',
      '',
    ].join('\n')
  );
  await writeAt(value.pristine, 'a/subst.subst', '$Format:%H$\n');
  await writeAt(value.pristine, 'a/gone.dropped', 'must still be exported\n');
  await writeAt(value.pristine, 'a/id.ident', '$Id$\n');
  await writeAt(value.pristine, 'a/lf.crlf', 'one\ntwo\n');
  await writeAt(value.pristine, 'a/auto.auto', Buffer.from('one\r\ntwo\r\n'));
  await writeAt(value.pristine, 'a/binary.bin', Buffer.from([0, 255, 10, 13, 10, 0]));
  await writeAt(value.pristine, 'a/run.sh', '#!/bin/sh\nexit 0\n', true);
  await writeAt(value.pristine, `a/${'long-name-'.repeat(12)}/file.txt`, 'deep\n');
  await writeAt(value.pristine, 'engine/inner.txt', 'a top-level engine directory upstream\n');
  await symlink('run.sh', join(value.pristine, 'a/link'));
  // Bytes as authored reach the object store only with conversion off.
  await sourceGit(value.pristine, ['-c', 'core.autocrlf=false', 'add', '-A']);
  await commitFixture(value.pristine);
  const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  return { root: value.root, pristine: value.pristine, commit };
}

it('exports a pristine tree byte for byte, whatever its attributes ask for', async () => {
  const { root, pristine, commit } = await hostilePristine();
  const destination = join(dirname(root), 'seed');
  await exportPristineTree(pristine, commit, destination);
  const entries = await entriesOf(pristine, commit);
  for (const entry of entries) {
    const target = join(destination, entry.path);
    if (entry.mode === '120000') continue;
    const stored = await sourceGit(pristine, ['cat-file', 'blob', entry.blob]);
    expect((await readFile(target)).equals(stored), entry.path).toBe(true);
    expect(((await stat(target)).mode & 0o777).toString(8)).toBe(
      entry.mode === '100755' ? '755' : '644'
    );
  }
  expect(await readFile(join(destination, 'a/subst.subst'), 'utf8')).toBe('$Format:%H$\n');
  expect(await readFile(join(destination, 'a/gone.dropped'), 'utf8')).toContain('still');
  expect(await readFile(join(destination, 'a/id.ident'), 'utf8')).toBe('$Id$\n');
  expect(await readFile(join(destination, 'a/lf.crlf'), 'utf8')).toBe('one\ntwo\n');
  expect(await readlink(join(destination, 'a/link'))).toBe('run.sh');
});

it('catches tampered bytes, a flipped mode, extra files and missing files', async () => {
  const { root, pristine, commit } = await hostilePristine();
  const destination = join(dirname(root), 'seed');
  await exportPristineTree(pristine, commit, destination);
  const entries = await entriesOf(pristine, commit);
  const check = (): Promise<void> => verifyExportedTree(pristine, entries, destination, 'sha1');
  await expect(check()).resolves.toBeUndefined();

  const original = await readFile(join(destination, 'a/lf.crlf'));
  await writeFile(join(destination, 'a/lf.crlf'), 'one\r\ntwo\r\n');
  await expect(check()).rejects.toThrow('authored-export-mismatch: bytes a/lf.crlf');
  await writeFile(join(destination, 'a/lf.crlf'), original);

  await writeFile(join(destination, 'extra.txt'), 'x');
  await expect(check()).rejects.toThrow('authored-export-mismatch: unexpected extra.txt');
  await rm(join(destination, 'extra.txt'));

  await chmod(join(destination, 'a/run.sh'), 0o644);
  await expect(check()).rejects.toThrow('authored-export-mismatch: kind or mode a/run.sh');
  await chmod(join(destination, 'a/run.sh'), 0o755);

  await rm(join(destination, 'a/binary.bin'));
  await expect(check()).rejects.toThrow('authored-export-mismatch: missing a/binary.bin');
});

it('refuses a link escaping the destination before extracting anything', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await symlink('../../outside', join(value.pristine, 'browser/escape'));
  await commitFixture(value.pristine);
  const commit = (await sourceGit(value.pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  const destination = join(dirname(value.root), 'seed');
  await expect(exportPristineTree(value.pristine, commit, destination)).rejects.toThrow(
    'authored-pristine-link-escape: browser/escape'
  );
});

it('seeds a usable engine and exports captured inputs from a linked worktree', async () => {
  const { root, pristine, commit } = await hostilePristine();
  await sourceGit(pristine, ['rev-parse', commit]);
  const config = JSON.parse(await readFile(join(root, 'fireforge.json'), 'utf8')) as {
    sources: { pristineCommit: string };
  };
  config.sources.pristineCommit = commit;
  await writeAt(root, 'fireforge.json', JSON.stringify(config));
  await commitFixture(root);
  const worktree = join(dirname(root), 'wt');
  await sourceGit(root, ['worktree', 'add', '-q', worktree]);
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: worktree,
    pristineRepository: pristine,
  });
  const captured = join(dirname(root), 'captured');
  await exportCapturedTree(snapshot, captured);
  expect(await readFile(join(captured, 'src/browser/new.js'), 'utf8')).toContain('value = 1');
  const engine = join(dirname(root), 'engine-seed');
  await exportPristineTree(pristine, commit, engine);
  await materializeAuthoredSnapshot({
    snapshot,
    engineDir: engine,
    ledgerPath: join(dirname(root), 'ledger.json'),
    pristineRepository: pristine,
  });
  expect(await readFile(join(engine, 'browser/new.js'), 'utf8')).toContain('value = 1');
  await mkdir(join(dirname(root), 'occupied'));
  await writeFile(join(dirname(root), 'occupied/x'), 'x');
  await expect(
    exportPristineTree(pristine, commit, join(dirname(root), 'occupied'))
  ).rejects.toThrow('authored-export-destination-not-empty');
});

it('moves through directory and file transitions, and refuses one that would remove a foreign file', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const { root, pristine, commit } = value;
  const engine = join(dirname(root), 'engine-seed');
  const ledgerPath = join(dirname(root), 'ledger.json');
  await exportPristineTree(pristine, commit, engine);
  const materialize = async (): Promise<void> => {
    await commitFixture(root);
    await materializeAuthoredSnapshot({
      snapshot: await captureAuthoredSnapshot({ projectRoot: root, pristineRepository: pristine }),
      engineDir: engine,
      ledgerPath,
      pristineRepository: pristine,
    });
  };
  await writeAt(root, 'src/browser/dir/inner.js', 'export const inner = 1;\n');
  await materialize();
  await rm(join(root, 'src/browser/dir'), { recursive: true });
  await writeAt(root, 'src/browser/dir', 'now a file\n');
  await materialize();
  expect(await readFile(join(engine, 'browser/dir'), 'utf8')).toBe('now a file\n');
  await rm(join(root, 'src/browser/dir'));
  await writeAt(root, 'src/browser/dir/inner.js', 'a directory again\n');
  await materialize();
  expect(await readFile(join(engine, 'browser/dir/inner.js'), 'utf8')).toBe('a directory again\n');
  await writeAt(engine, 'browser/dir/foreign.js', 'not ours\n');
  await rm(join(root, 'src/browser/dir'), { recursive: true });
  await writeAt(root, 'src/browser/dir', 'blocked\n');
  await expect(materialize()).rejects.toThrow('authored-invalid-output-kind: browser/dir');
  expect(await readFile(join(engine, 'browser/dir/foreign.js'), 'utf8')).toBe('not ours\n');
});
