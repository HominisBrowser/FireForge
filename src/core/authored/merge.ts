// SPDX-License-Identifier: EUPL-1.2
import { readFile, stat, writeFile } from 'node:fs/promises';

import { GeneralError } from '../../errors/base.js';
import { toError } from '../../utils/errors.js';
import { loadConfig } from '../config.js';
import {
  digest,
  pristineRepositoryFor,
  readSourceBlob,
  sourceGit,
  sourceGitStatus,
} from './git.js';
import { assertSourcePath } from './paths.js';
import { parseDeclaration, readPristineEntry, requireAuthoredConfig } from './provider.js';
import { mergeRefreshImages } from './refresh-merge.js';
import type { SourceFileMode } from './types.js';

export const AUTHORED_MERGE_DRIVER = 'fireforge-authored';

/** The installed form of this CLI, as Git's shell will run it. */
function currentCliCommand(): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  return [process.execPath, ...process.execArgv, process.argv[1] ?? 'fireforge']
    .map(quote)
    .join(' ');
}

/**
 * Name the driver in this repository's shared configuration, so linked worktrees have it too. A
 * repository without it still merges, with Git's ordinary add/add conflict.
 */
export async function installAuthoredMergeDriver(
  projectRoot: string,
  command: string = currentCliCommand()
): Promise<string> {
  const driver = `${command} authored merge-driver %O %A %B %P`;
  const key = `merge.${AUTHORED_MERGE_DRIVER}`;
  await sourceGit(projectRoot, ['config', '--local', `${key}.name`, 'FireForge authored source']);
  await sourceGit(projectRoot, ['config', '--local', `${key}.driver`, driver]);
  return driver;
}

/** Whether the driver is configured; `src/.gitattributes` alone does not make Git use it. */
export async function authoredMergeDriverInstalled(projectRoot: string): Promise<boolean> {
  const result = await sourceGitStatus(projectRoot, [
    'config',
    '--local',
    '--get',
    `merge.${AUTHORED_MERGE_DRIVER}.driver`,
  ]);
  return result.code === 0;
}

/** The pristine image a first touch of `path` started from, from the side being merged into. */
async function firstTouchAncestor(
  projectRoot: string,
  path: string,
  pristineRepository: string | undefined
): Promise<{ bytes: Buffer; mode: SourceFileMode } | undefined> {
  const config = await loadConfig(projectRoot);
  const sources = requireAuthoredConfig(config);
  if (!path.startsWith(`${sources.root}/`)) return undefined;
  const enginePath = path.slice(sources.root.length + 1);
  assertSourcePath(enginePath);
  const sidecar = await sourceGitStatus(projectRoot, [
    'cat-file',
    'blob',
    `HEAD:${sources.metadataRoot}/overrides/${enginePath}.json`,
  ]);
  if (sidecar.code !== 0) return undefined;
  const declaration = parseDeclaration(JSON.parse(sidecar.stdout.toString('utf8')) as unknown);
  const donor = pristineRepositoryFor(projectRoot, pristineRepository);
  const pin = digest({ firefox: config.firefox, commit: sources.pristineCommit });
  const pristine = await readPristineEntry(donor, sources.pristineCommit, enginePath);
  if (
    declaration.path !== enginePath ||
    declaration.base.pin !== pin ||
    declaration.base.commit !== sources.pristineCommit ||
    pristine?.blob !== declaration.base.blob ||
    pristine.mode !== declaration.base.mode
  )
    throw new GeneralError(`override-base-mismatch: ${enginePath}`);
  return { bytes: await readSourceBlob(donor, pristine.blob), mode: pristine.mode };
}

/**
 * Git merge driver for source files. Two branches that first-touch one upstream file have no common
 * ancestor in the project's history, so Git offers an empty one; the sidecar names the real one.
 * Leaves the result in `ours`, returning false for a conflict, as the driver contract requires.
 */
export async function runAuthoredMergeDriver(options: {
  projectRoot: string;
  base: string;
  ours: string;
  theirs: string;
  path: string;
  pristineRepository?: string;
  onNotice?: (message: string) => void;
}): Promise<boolean> {
  const [baseBytes, ours, theirs] = await Promise.all(
    [options.base, options.ours, options.theirs].map((file) => readFile(file))
  );
  let ancestor: Buffer = baseBytes ?? Buffer.alloc(0);
  if ((await stat(options.base)).size === 0) {
    try {
      const pristine = await firstTouchAncestor(
        options.projectRoot,
        options.path,
        options.pristineRepository
      );
      if (pristine) ancestor = pristine.bytes;
    } catch (error: unknown) {
      options.onNotice?.(
        `No pristine ancestor for ${options.path}: ${toError(error).message}. Merging as add/add.`
      );
    }
  }
  const merged = await mergeRefreshImages(
    { bytes: ancestor, mode: '100644' },
    { bytes: ours ?? Buffer.alloc(0), mode: '100644' },
    { bytes: theirs ?? Buffer.alloc(0), mode: '100644' },
    { local: 'ours', base: 'base', other: 'theirs' }
  );
  if (merged.ok) {
    await writeFile(options.ours, merged.image?.bytes ?? Buffer.alloc(0));
    return true;
  }
  if (merged.markers) await writeFile(options.ours, merged.markers);
  return false;
}
