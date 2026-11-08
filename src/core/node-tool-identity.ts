// SPDX-License-Identifier: EUPL-1.2
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { getNodeErrorCode } from '../utils/errors.js';
import { dependencyGraphIdentity } from './jobs/dependency-identity.js';

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
      const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (metadata.name === name)
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
