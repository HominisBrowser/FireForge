// SPDX-License-Identifier: EUPL-1.2
import { readdir, rmdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { FurnaceConfig } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, removeDir, removeFile } from '../utils/fs.js';
import { assertNoSourceAliases } from './authored/paths.js';
import {
  authoredMutationPublished,
  authoredMutationWillPublish,
  withAuthoredPathLock,
} from './authored/write-lock.js';
import { authoringProjectRoot, removeAuthoredOverrideUnlocked } from './authored/writer.js';
import { loadConfig } from './config.js';
import { mapDeployedComponentSources } from './furnace-composed-source.js';
import { type RollbackJournal, snapshotFile, trackRollbackMutations } from './furnace-rollback.js';

interface AuthoredTarget {
  root: string;
  path: string;
  sidecar: string;
}

/** Authored transactions cannot report success after a best-effort source/test edit failed. */
export async function refusePartialAuthoredMutation(path: string, error: unknown): Promise<void> {
  const root = await authoringProjectRoot(path);
  if (!(await pathExists(join(root, 'fireforge.json')))) return;
  if ((await loadConfig(root)).sources) throw toError(error);
}

async function sourceTarget(path: string): Promise<AuthoredTarget | undefined> {
  const root = await authoringProjectRoot(dirname(path));
  if (!(await pathExists(join(root, 'fireforge.json')))) return undefined;
  const config = await loadConfig(root);
  if (!config.sources) return undefined;
  const sourceRoot = resolve(root, config.sources.root),
    absolute = resolve(path);
  if (!absolute.startsWith(sourceRoot + sep)) return undefined;
  const sourcePath = relative(sourceRoot, absolute).split(sep).join('/');
  await assertNoSourceAliases(root, `${config.sources.root}/${sourcePath}`);
  return {
    root,
    path: sourcePath,
    sidecar: join(root, config.sources.metadataRoot, 'overrides', `${sourcePath}.json`),
  };
}

/** Removing an upstream postimage restores pristine meaning; it never implicitly creates a tombstone. */
export async function removeAuthoringFile(
  path: string,
  journal: RollbackJournal,
  legacyRemove: (path: string) => Promise<void> = removeFile
): Promise<void> {
  const target = await sourceTarget(path);
  if (target === undefined) {
    await legacyRemove(path);
    return;
  }
  await trackRollbackMutations(
    () => journal,
    () =>
      withAuthoredPathLock(target.root, target.path, async (root) => {
        const current = await sourceTarget(path);
        if (!current || current.path !== target.path)
          throw new Error('authored-removal-target-moved');
        await snapshotFile(journal, path);
        if (await pathExists(current.sidecar)) {
          await snapshotFile(journal, current.sidecar);
          await removeAuthoredOverrideUnlocked(root, target.path);
        } else {
          const config = await loadConfig(root);
          if (!config.sources) throw new Error('authored-removal-mode-moved');
          const source = `${config.sources.root}/${target.path}`;
          await authoredMutationWillPublish(root, [source]);
          await removeFile(path);
          await authoredMutationPublished(root, [source]);
        }
      })
  );
}

/** Source directories retire each declared postimage transactionally; derived engine trees are not addressed. */
export async function removeAuthoringDir(path: string, journal: RollbackJournal): Promise<void> {
  if (!(await pathExists(path))) return;
  const target = await sourceTarget(path);
  if (target === undefined) {
    await removeDir(path);
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await removeAuthoringDir(child, journal);
    else await removeAuthoringFile(child, journal);
  }
  await rmdir(path);
}

/** Generated overrides no longer produced by a renamed/removed component restore pristine on next materialization. */
export async function retireGeneratedDeclarations(
  root: string,
  after: FurnaceConfig,
  journal: RollbackJournal,
  oldSources: ReadonlySet<string>
): Promise<void> {
  const config = await loadConfig(root);
  if (!config.sources) return;
  const next = await mapDeployedComponentSources(root, after);
  for (const path of oldSources) {
    if (next.has(path)) continue;
    await trackRollbackMutations(
      () => journal,
      () =>
        withAuthoredPathLock(root, path, async (canonical) => {
          const current = await loadConfig(canonical);
          if (!current.sources) throw new Error('authored-removal-mode-moved');
          const sidecar = join(
            canonical,
            current.sources.metadataRoot,
            'overrides',
            `${path}.json`
          );
          if (!(await pathExists(sidecar))) return;
          const postimage = join(canonical, current.sources.root, path);
          await snapshotFile(journal, sidecar);
          await snapshotFile(journal, postimage);
          await removeAuthoredOverrideUnlocked(canonical, path);
        })
    );
  }
}
