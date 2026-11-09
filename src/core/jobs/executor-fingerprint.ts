// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getNodeErrorCode } from '../../utils/errors.js';
import { dependencyGraphIdentity } from './dependency-identity.js';
import { sourceLoaderIdentity } from './source-loader.js';
import { fileDigest, walkTree } from './tool-files.js';

/** Bind shipped runtime code and resolved production dependency graph; published packages need not contain a lockfile. */
export async function executorFingerprint(): Promise<string> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const packageRoot = import.meta.url.endsWith('.ts')
    ? root
    : fileURLToPath(new URL('../../../../', import.meta.url));
  const hash = createHash('sha256');
  const visit = (directory: string, label: string, skipTests = true): Promise<void> =>
    walkTree(
      directory,
      async ({ path, label: key, info }) => {
        if (info.isSymbolicLink())
          throw new Error(`Own executor asset alias requires authentication: ${key}`);
        if (info.isFile()) hash.update(key).update(await fileDigest(path, info));
      },
      {
        prefix: label,
        skip: (name) =>
          name === 'node_modules' ||
          name === '.git' ||
          (skipTests &&
            (['__tests__', 'tests', 'test', 'docs', 'examples'].includes(name) ||
              name.includes('.test.'))),
      }
    );
  await visit(join(root, 'src'), 'src');
  await visit(join(root, 'bin'), 'bin');
  await visit(join(packageRoot, 'templates'), 'templates', false);
  await visit(join(packageRoot, 'runtime'), 'bootstrap', false);
  if (!import.meta.url.endsWith('.ts'))
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (['src', 'bin'].includes(entry.name)) continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) await visit(path, `runtime/${entry.name}`);
      else if (entry.isFile()) hash.update(`runtime/${entry.name}`).update(await readFile(path));
      else throw new Error('Unsupported own-package runtime asset');
    }
  const manifest = await readFile(join(packageRoot, 'package.json'));
  hash.update('package.json').update(manifest);
  try {
    hash.update('package-lock.json').update(await readFile(join(packageRoot, 'package-lock.json')));
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    hash.update('package-lock-not-shipped');
  }
  hash.update('dependency-graph').update(await dependencyGraphIdentity(packageRoot));
  if (import.meta.url.endsWith('.ts'))
    hash.update('source-loader').update(await sourceLoaderIdentity(packageRoot, import.meta.url));
  return hash.digest('hex');
}
