// SPDX-License-Identifier: EUPL-1.2
/** A pin's template and the removal of what a slot leaves, on real trees. */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import {
  ensureTemplate,
  finishTrash,
  moveToTrash,
  pathPresent,
  readTemplate,
  removeTree,
} from '../slot-template.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) {
    await promisify(execFile)('chmod', ['-R', 'u+rwX', path]).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fireforge-slot-template-'));
  directories.push(path);
  return path;
}

/** A tree a qualified site would be: read-only all the way down. */
async function frozenTree(root: string): Promise<string> {
  const tree = join(root, 'tree');
  await mkdir(join(tree, 'inner'), { recursive: true });
  await writeFile(join(tree, 'inner', 'file'), 'bytes');
  await chmod(join(tree, 'inner'), 0o500);
  await chmod(tree, 0o500);
  return tree;
}

describe.skipIf(process.platform === 'win32')('a pin’s template', () => {
  it('is exported once however many ask at the same moment, over what a crash left', async () => {
    const f = await sourceFixture();
    directories.push(dirname(f.root));
    const namespace = join(dirname(f.root), 'coordinator');
    const { commit } = f;
    // A crash mid-export leaves this beside the final name, where nothing can mistake it for one.
    const leftover = join(namespace, 'templates', `${commit}.building-old`);
    await mkdir(leftover, { recursive: true });
    expect(await readTemplate(namespace, commit)).toBeUndefined();
    const [one, two] = await Promise.all([
      ensureTemplate(namespace, f.pristine, commit),
      ensureTemplate(namespace, f.pristine, commit),
    ]);
    expect(two.directory).toBe(one.directory);
    expect(one.sourceBytes).toBeGreaterThan(0);
    const present = await readdir(join(namespace, 'templates'));
    expect(present).toContain(commit);
    expect(present.some((name) => name.includes('.building-'))).toBe(false);
    expect(await readTemplate(namespace, commit)).toEqual(one);
    expect(await ensureTemplate(namespace, f.pristine, commit)).toEqual(one);
  }, 60_000);

  it('refuses what is not a pristine repository, and leaves no template', async () => {
    const namespace = await directory();
    await expect(ensureTemplate(namespace, join(namespace, 'absent'), 'pin')).rejects.toThrow();
    expect(await readTemplate(namespace, 'pin')).toBeUndefined();
    expect((await readdir(join(namespace, 'templates'))).filter((n) => n === 'pin')).toEqual([]);
  });

  it('propagates a template record it cannot read, rather than building over it', async () => {
    const namespace = await directory();
    await mkdir(join(namespace, 'templates', 'pin'), { recursive: true });
    await writeFile(join(namespace, 'templates', 'pin', 'template.json'), '{ not json');
    await expect(readTemplate(namespace, 'pin')).rejects.toThrow();
  });
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('removing a tree', () => {
  it('deletes what is read-only on purpose', async () => {
    const tree = await frozenTree(await directory());
    await removeTree(tree);
    expect(await pathPresent(tree)).toBe(false);
    // Nothing there is nothing to do.
    await removeTree(tree);
  });

  it('finishes what a move to the trash started, and has nothing to do with no trash', async () => {
    const namespace = await directory();
    expect(await finishTrash(namespace)).toEqual([]);
    const tree = await frozenTree(namespace);
    // The tree itself has to be writable to move; what is frozen in a real slot is deeper down.
    await chmod(tree, 0o700);
    await moveToTrash(namespace, tree, 'gone');
    expect(await pathPresent(tree)).toBe(false);
    expect(await finishTrash(namespace)).toEqual(['gone']);
    expect(await readdir(join(namespace, 'trash'))).toEqual([]);
  });

  it('tells absent from a path it cannot ask about', async () => {
    const root = await directory();
    await writeFile(join(root, 'file'), '');
    expect(await pathPresent(join(root, 'file'))).toBe(true);
    expect(await pathPresent(join(root, 'absent'))).toBe(false);
    await expect(pathPresent(join(root, 'file', 'below'))).rejects.toThrow(/ENOTDIR/);
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('');
  });
});
