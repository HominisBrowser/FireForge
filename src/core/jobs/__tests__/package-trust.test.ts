// SPDX-License-Identifier: EUPL-1.2
/** What vouches for a slot's built package, and what its signature leaves out. */
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertPackageUnchanged, PackageChangedError, signPackage } from '../package-signature.js';
import type { SlotRecord } from '../slot-types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function builtRoot(): Promise<{ root: string; bin: string; slot: SlotRecord }> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-package-'));
  roots.push(root);
  const bin = join(root, 'engine/obj-x/dist/bin');
  await mkdir(join(bin, 'browser'), { recursive: true });
  await writeFile(join(bin, 'firefox'), 'binary');
  await writeFile(join(bin, 'browser/omni.ja'), 'chrome');
  await symlink('../../somewhere', join(bin, 'browser/link'));
  await mkdir(join(root, 'engine/obj-x/dist/App.app/Contents/MacOS'), { recursive: true });
  await writeFile(join(root, 'engine/obj-x/dist/App.app/Contents/MacOS/firefox'), 'bundled');
  const slot = {
    id: 'a',
    root,
    packageSignature: await signPackage(root),
  } as unknown as SlotRecord;
  return { root, bin, slot };
}

describe('a package signature', () => {
  it('moves with a file replaced, added, removed or relinked', async () => {
    for (const change of [
      async ({ bin }: { bin: string }) => {
        await writeFile(join(bin, 'firefox'), 'different binary');
      },
      async ({ bin }: { bin: string }) => {
        await writeFile(join(bin, 'added'), 'x');
      },
      async ({ bin }: { bin: string }) => {
        await rm(join(bin, 'browser/omni.ja'));
      },
      async ({ bin }: { bin: string }) => {
        await rm(join(bin, 'browser/link'));
        await symlink('../../elsewhere', join(bin, 'browser/link'));
      },
      async ({ root }: { root: string }) => {
        await writeFile(join(root, 'engine/obj-x/dist/App.app/Contents/MacOS/firefox'), 'other');
      },
    ]) {
      const built = await builtRoot();
      await change(built);
      await expect(assertPackageUnchanged(built.slot)).rejects.toBeInstanceOf(PackageChangedError);
    }
  });

  it('moves with the same bytes at a different time, and says what moved', async () => {
    const { bin, slot } = await builtRoot();
    const later = new Date(Date.now() + 60_000);
    await utimes(join(bin, 'firefox'), later, later);
    await expect(assertPackageUnchanged(slot)).rejects.toThrow(/firefox/);
  });

  it('ignores what a browser or harness writes beside the package, and a directory’s mtime', async () => {
    const { bin, slot } = await builtRoot();
    await writeFile(join(bin, '.parentlock'), '');
    await writeFile(join(bin, 'browser/session.log'), 'noise');
    await mkdir(join(bin, 'updates/0'), { recursive: true });
    await mkdir(join(bin, 'browser/__pycache__'));
    await writeFile(join(bin, 'browser/__pycache__/a.pyc'), 'cache');
    await writeFile(join(bin, 'transient'), '');
    await rm(join(bin, 'transient'));
    await expect(assertPackageUnchanged(slot)).resolves.toBeUndefined();
  });

  it('ignores the purge-caches marker a build leaves and the browser removes at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-package-'));
    roots.push(root);
    const resources = join(root, 'engine/obj-x/dist/App.app/Contents/Resources/browser');
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, 'omni.ja'), 'chrome');
    await writeFile(join(resources, '.purgecaches'), '');
    const slot = {
      id: 'a',
      root,
      packageSignature: await signPackage(root),
    } as unknown as SlotRecord;
    await rm(join(resources, '.purgecaches'));
    await expect(assertPackageUnchanged(slot)).resolves.toBeUndefined();
  });

  it('moves with what a link into its objdir resolves to, without the link changing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-package-'));
    roots.push(root);
    const bin = join(root, 'engine/obj-x/dist/bin');
    const app = join(root, 'engine/obj-x/browser/app');
    await mkdir(bin, { recursive: true });
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'firefox'), 'binary');
    await symlink('../../browser/app/firefox', join(bin, 'firefox'));
    // A linked objdir directory outside the package, holding a link back up to itself.
    const chrome = join(root, 'engine/obj-x/chrome');
    await mkdir(chrome, { recursive: true });
    await writeFile(join(chrome, 'a.js'), 'a');
    await symlink('..', join(chrome, 'up'));
    await symlink('../../chrome', join(bin, 'chrome'));
    await symlink('cycle-b', join(bin, 'cycle-a'));
    await symlink('cycle-a', join(bin, 'cycle-b'));
    const slot = { id: 'a', root, packageSignature: await signPackage(root) } as SlotRecord;
    await expect(assertPackageUnchanged(slot)).resolves.toBeUndefined();

    await writeFile(join(app, 'firefox'), 'a different binary');
    await expect(assertPackageUnchanged(slot)).rejects.toThrow(/firefox \(its target\)/);
    slot.packageSignature = await signPackage(root);
    await writeFile(join(chrome, 'a.js'), 'changed');
    await expect(assertPackageUnchanged(slot)).rejects.toBeInstanceOf(PackageChangedError);
  });

  it('leaves a link into the source tree to the slot audit, which binds captured source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-package-'));
    roots.push(root);
    const bin = join(root, 'engine/obj-x/dist/bin/browser/chrome');
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, 'engine/browser/base'), { recursive: true });
    await writeFile(join(root, 'engine/browser/base/a.js'), 'a');
    await symlink('../../../../../browser/base/a.js', join(bin, 'a.js'));
    const slot = { id: 'a', root, packageSignature: await signPackage(root) } as SlotRecord;
    await expect(readFile(join(bin, 'a.js'), 'utf8')).resolves.toBe('a');
    // A new source rewrites it before the build that repackages it.
    await writeFile(join(root, 'engine/browser/base/a.js'), 'the next source');
    await expect(assertPackageUnchanged(slot)).resolves.toBeUndefined();
  });

  it('binds a link resolving outside the slot by what it resolves to', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-package-'));
    const outside = await mkdtemp(join(tmpdir(), 'fireforge-outside-'));
    roots.push(root, outside);
    const bin = join(root, 'engine/obj-x/dist/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(outside, 'lib.dylib'), 'library');
    await symlink(join(outside, 'lib.dylib'), join(bin, 'lib.dylib'));
    const slot = { id: 'a', root, packageSignature: await signPackage(root) } as SlotRecord;
    await writeFile(join(outside, 'lib.dylib'), 'another library');
    await expect(assertPackageUnchanged(slot)).rejects.toBeInstanceOf(PackageChangedError);
  });

  it('has nothing to say about a slot that has no signature', async () => {
    const { root } = await builtRoot();
    await expect(
      assertPackageUnchanged({ id: 'a', root } as unknown as SlotRecord)
    ).resolves.toBeUndefined();
  });
});
