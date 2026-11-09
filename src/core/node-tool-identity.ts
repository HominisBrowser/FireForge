// SPDX-License-Identifier: EUPL-1.2
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

import { getNodeErrorCode } from '../utils/errors.js';
import { dependencyGraphIdentity } from './jobs/dependency-identity.js';

interface PackageMetadata {
  name?: string;
  version?: string;
}

/**
 * Whether npm installed `root` as an alias of `name` (`"name": "npm:other@x"`):
 * its directory is `node_modules/<name>`, and the install record npm keeps in
 * `node_modules/.package-lock.json` names the package and version found there.
 * Any other package whose metadata names something else stays unauthenticated.
 */
async function installedAsAlias(
  root: string,
  name: string,
  metadata: PackageMetadata
): Promise<boolean> {
  const marker = `${sep}node_modules${sep}`;
  if (!root.endsWith(`${marker}${name.split('/').join(sep)}`)) return false;
  const project = root.slice(0, root.indexOf(marker));
  const key = relative(project, root).split(sep).join('/');
  try {
    const record = JSON.parse(
      await readFile(join(project, 'node_modules', '.package-lock.json'), 'utf8')
    ) as { packages?: Record<string, PackageMetadata> };
    const installed = record.packages?.[key];
    return (
      installed !== undefined &&
      installed.name === metadata.name &&
      installed.version === metadata.version
    );
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Resolve from the consuming module's actual Node lookup path, including hoisted development tools. */
export async function resolvedNodeToolIdentity(name: string, from: string): Promise<string> {
  let entry: string;
  try {
    entry = createRequire(from).resolve(name);
  } catch (error) {
    if (getNodeErrorCode(error) === 'MODULE_NOT_FOUND') return 'absent';
    throw error;
  }
  let root = dirname(await realpath(entry));
  for (;;) {
    try {
      const metadata = JSON.parse(
        await readFile(join(root, 'package.json'), 'utf8')
      ) as PackageMetadata;
      if (metadata.name === name || (await installedAsAlias(root, name, metadata)))
        return await dependencyGraphIdentity(root, { includeRootFiles: true });
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
    const parent = dirname(root);
    if (parent === root) throw new Error(`Resolved tool package is not authenticated: ${name}`);
    root = parent;
  }
}

const loaded = new Map<string, Promise<string>>();
/** One process loads one compiler implementation; fresh phases/processes resolve fresh byte identities. */
export function loadedNodeToolIdentity(name: string, from: string): Promise<string> {
  const key = JSON.stringify([name, from]);
  let pending = loaded.get(key);
  if (!pending) {
    pending = resolvedNodeToolIdentity(name, from);
    loaded.set(key, pending);
  }
  return pending;
}
