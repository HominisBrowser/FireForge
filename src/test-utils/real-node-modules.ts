// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/**
 * A `node_modules` shaped the way real ones are, which a minimal fixture is not:
 * a package whose manifest has no `name` (Firefox's own `engine/node_modules` holds
 * three), a scoped one, a directory with no manifest, a relative `.bin` link, a
 * broken link, and a link out of the tree such as `npm link` leaves.
 *
 * @param root - Directory to create `node_modules` in
 */
export async function writeRealShapedNodeModules(root: string): Promise<void> {
  const modules = join(root, 'node_modules');
  await put(join(modules, 'acorn', 'package.json'), '{"name":"acorn","version":"8.0.0"}\n');
  await put(join(modules, 'acorn', 'bin', 'acorn'), '#!/usr/bin/env node\n');
  await put(join(modules, '@typescript', 'lib-dom', 'package.json'), '{"version":"1.0.0"}\n');
  await put(join(modules, 'eslint-plugin-sdl', 'package.json'), '{"private":true}\n');
  await put(join(modules, 'stray-directory', 'file.txt'), 'no manifest here\n');
  await mkdir(join(modules, '.bin'), { recursive: true });
  await symlink('../acorn/bin/acorn', join(modules, '.bin', 'acorn'));
  await symlink('./no-such-package', join(modules, 'broken-link'));
  const linked = await mkdtemp(join(tmpdir(), 'fireforge-npm-link-'));
  await put(join(linked, 'package.json'), '{"name":"linked"}\n');
  await symlink(linked, join(modules, 'linked'));
}
