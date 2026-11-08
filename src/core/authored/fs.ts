// SPDX-License-Identifier: EUPL-1.2
import { dirname, join, relative, resolve, sep } from 'node:path';

import * as legacy from '../../utils/fs.js';
import { loadConfig } from '../config.js';
import { projectRootAbove } from './write-lock.js';
import { routedAuthoringPath, writeAuthoredSourceFile } from './writer.js';

export * from '../../utils/fs.js';

const reads = new Map<string, Buffer>();

/** Source-aware filesystem adapter used only by sanctioned authoring helpers. */
export async function readText(path: string): Promise<string> {
  const target = await routedAuthoringPath(path);
  const text = await legacy.readText(target);
  reads.set(target, Buffer.from(text));
  return text;
}

/** Probe the tracked destination selected for a sanctioned authoring helper. */
export async function pathExists(path: string): Promise<boolean> {
  return legacy.pathExists(await routedAuthoringPath(path));
}

/** Write source with a compare-before-write guard while preserving legacy behavior. */
export async function writeText(path: string, content: string): Promise<void> {
  const target = await routedAuthoringPath(path);
  const root = await projectRootAbove(dirname(resolve(target)));
  const sources = root === undefined ? undefined : (await loadConfig(root)).sources;
  if (root === undefined || sources === undefined) {
    await legacy.writeText(path, content);
    return;
  }
  const sourceRoot = join(root, sources.root);
  if (!target.startsWith(sourceRoot + sep)) {
    await legacy.writeText(target, content);
    return;
  }
  const expected = reads.get(target);
  await writeAuthoredSourceFile(
    root,
    relative(sourceRoot, target).split(sep).join('/'),
    Buffer.from(content),
    expected === undefined ? {} : { expected }
  );
  reads.set(target, Buffer.from(content));
}
