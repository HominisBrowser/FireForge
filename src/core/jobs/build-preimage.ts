// SPDX-License-Identifier: EUPL-1.2
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { sourceGit } from '../authored/git.js';
import { readSourceBlobs } from '../authored/index.js';
import { assertNoSourceAliases } from '../authored/paths.js';
import type { AuthoredSnapshot, CapturedInput } from '../authored/types.js';
import type { BuildDerivedFile, SlotRecord } from './slot-types.js';
import { readRegularFile } from './tool-files.js';

/** Read just the generator's closed pristine paths, in one tree query and one blob batch. */
export async function buildPristineInputs(
  slot: SlotRecord,
  paths: readonly string[]
): Promise<{ entries: Map<string, CapturedInput>; blobs: Map<string, Buffer> }> {
  if (paths.length === 0) return { entries: new Map(), blobs: new Map() };
  const raw = (
    await sourceGit(slot.pristineRepository, [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      slot.pin,
      '--',
      ...paths,
    ])
  ).toString();
  const entries = new Map<string, CapturedInput>();
  for (const row of raw.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Unsupported pristine build input kind');
    entries.set(match[3] ?? '', {
      path: match[3] ?? '',
      mode: match[1] as '100644' | '100755',
      blob: match[2] ?? '',
    });
  }
  return {
    entries,
    blobs: await readSourceBlobs(
      slot.pristineRepository,
      [...entries.values()].map((entry) => entry.blob)
    ),
  };
}

/** Refuse foreign bytes before a sanctioned writer can erase them; no whole-engine scan is needed here. */
export async function assertBuildPreimages(
  slot: SlotRecord,
  snapshot: AuthoredSnapshot,
  paths: readonly string[],
  previous: Record<string, BuildDerivedFile>,
  derived: Record<string, BuildDerivedFile>
): Promise<void> {
  const pristine = await buildPristineInputs(slot, paths);
  const owned = new Map(snapshot.files.map((file) => [file.path, file]));
  const blobs = await readSourceBlobs(
    snapshot.repository,
    paths.flatMap((path) => (owned.get(path)?.blob ? [owned.get(path)?.blob as string] : []))
  );
  for (const path of paths) {
    await assertNoSourceAliases(join(slot.root, 'engine'), path);
    let stat;
    try {
      stat = await lstat(join(slot.root, 'engine', path));
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
    const source = owned.get(path);
    if (source?.kind === 'delete')
      throw new Error(`Build generator conflicts with an authored deletion: ${path}`);
    const declared = previous[path] ?? derived[`engine/${path}`];
    const base = source?.blob
      ? { bytes: blobs.get(source.blob), mode: source.mode }
      : pristine.entries.get(path)
        ? {
            bytes: pristine.blobs.get(pristine.entries.get(path)?.blob ?? ''),
            mode: pristine.entries.get(path)?.mode,
          }
        : undefined;
    if (stat === undefined) {
      if (declared || base) throw new Error(`Known build input disappeared: ${path}`);
      continue;
    }
    const file = await readRegularFile(
      join(slot.root, 'engine', path),
      `Build writer input aliases another path: ${path}`
    );
    if (declared) {
      if (file.mode !== declared.mode || file.sha256 !== declared.sha256)
        throw new Error(`Foreign build writer input: ${path}`);
    } else if (!base?.bytes || file.mode !== base.mode || !file.bytes.equals(base.bytes))
      throw new Error(`Foreign build writer input: ${path}`);
  }
}
