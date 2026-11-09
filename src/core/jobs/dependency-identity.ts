// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { fileDigest, walkTree } from './tool-files.js';

interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function dependencyDirectory(parent: string, name: string): Promise<string | undefined> {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name === '.' || name === '..')
    throw new Error(`Invalid dependency package name: ${name}`);
  let directory = parent;
  for (;;) {
    if (basename(directory) !== 'node_modules') {
      const candidate = join(directory, 'node_modules', name);
      try {
        await readFile(join(candidate, 'package.json'));
        return await realpath(candidate);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) throw error;
      }
    }
    const next = dirname(directory);
    if (next === directory) return undefined;
    directory = next;
  }
}

async function packageFiles(directory: string): Promise<string> {
  const hash = createHash('sha256');
  await walkTree(
    directory,
    async ({ path, label, info }) => {
      if (info.isSymbolicLink())
        throw new Error(`Dependency runtime symlink requires explicit authentication: /${label}`);
      if (info.isFile()) {
        hash.update(JSON.stringify([label, info.size])).update(await fileDigest(path, info));
      } else if (!info.isDirectory())
        throw new Error(`Unsupported dependency runtime entry: /${label}`);
    },
    { skip: (name) => name === 'node_modules' || name === '.git' }
  );
  return hash.digest('hex');
}

/** Bind actual recursively resolved production/optional/peer package bytes, independent of install location. */
export async function dependencyGraphIdentity(
  packageRoot: string,
  options: { includeRootFiles?: boolean } = {}
): Promise<string> {
  const records: unknown[] = [];
  const seen = new Map<string, number>();
  const visit = async (directory: string, root = false): Promise<number> => {
    const canonical = await realpath(directory);
    const existing = seen.get(canonical);
    if (existing !== undefined) return existing;
    const index = records.length;
    seen.set(canonical, index);
    records.push(null);
    const bytes = await readFile(join(canonical, 'package.json'));
    const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;
    const dependencies = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    const edges: Array<[string, number | 'absent-optional']> = [];
    for (const name of Object.keys(dependencies).sort()) {
      const resolved = await dependencyDirectory(canonical, name);
      if (!resolved) {
        if (
          name in (manifest.optionalDependencies ?? {}) ||
          (!(name in (manifest.dependencies ?? {})) &&
            manifest.peerDependenciesMeta?.[name]?.optional === true)
        )
          edges.push([name, 'absent-optional']);
        else throw new Error(`Cannot authenticate required runtime dependency ${name}`);
      } else edges.push([name, await visit(resolved)]);
    }
    records[index] = {
      manifest: bytes.toString('base64'),
      files:
        root && !options.includeRootFiles
          ? 'root-bound-by-executor'
          : await packageFiles(canonical),
      edges,
    };
    return index;
  };
  await visit(packageRoot, true);
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
