// SPDX-License-Identifier: EUPL-1.2
/**
 * Argument checks `fireforge re-export` runs before it queues for the
 * engine session lock.
 *
 * Under contention the lock wait runs to many minutes, and an argument the
 * run was always going to refuse (an empty patch name from an unquoted
 * `"$@"`, a changed-file path passed as a positional, a path flag that
 * swallowed the next flag) is reported before that wait: these checks read the manifest and a path-scoped `git status` without the lock.
 * The command repeats its own resolution under the lock, so a manifest that
 * changes in between is still read fresh there.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { getProjectPaths } from '../core/config.js';
import { isGitRepository } from '../core/git.js';
import { chunkPathspecs } from '../core/git-base.js';
import { getDirtyFiles } from '../core/git-status.js';
import { formatPatchNotFoundError } from '../core/patch-identifier-suggest.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../core/patch-manifest.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest, ReExportOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import {
  normalizeReExportFilesPositionals,
  validateReExportOptionCombinations,
} from './re-export-options.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';
import { splitScanFileOwner } from './re-export-scan-owner.js';

/**
 * Reads a path list file: one engine-relative path per line, blank lines
 * and `#` comment lines ignored. Backs `--expect-from`, which exists because
 * a list held in one shell variable reaches the CLI as one argument under
 * zsh, and splitting it by hand left every path after the first as a
 * positional patch name.
 *
 * @param file - The list file, relative to the working directory
 * @param flag - Flag name for error messages
 */
export async function readPathListFile(file: string, flag: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(resolve(file), 'utf8');
  } catch (error: unknown) {
    throw new InvalidArgumentError(
      `${flag} could not read ${file}: ${toError(error).message}`,
      flag
    );
  }
  const paths = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (paths.length === 0) {
    throw new InvalidArgumentError(
      `${flag} file ${file} lists no paths. An empty list is usually a generation step that ` +
        `failed; write one engine-relative path per line, or drop ${flag}.`,
      flag
    );
  }
  return paths;
}

/** Engine-relative form of a positional, or undefined when it cannot be one. */
function asEnginePath(value: string): string | undefined {
  try {
    return normalizeEngineRelativeInput(value, 'patch');
  } catch {
    return undefined;
  }
}

async function resolvePositionals(
  engineDir: string,
  patches: readonly string[],
  manifest: PatchesManifest
): Promise<void> {
  for (const identifier of patches) {
    if (resolvePatchIdentifier(identifier, manifest.patches)) continue;
    const enginePath = asEnginePath(identifier);
    if (enginePath !== undefined && (await pathExists(join(engineDir, enginePath)))) {
      throw new InvalidArgumentError(
        `"${identifier}" is a file in engine/, not a patch. re-export takes patch identifiers ` +
          `as positionals. To name a file whose drift this run expects, pass --expect ` +
          `${enginePath} (one --expect per path), or list the paths one per line in a file ` +
          'and pass --expect-from <file>.',
        identifier
      );
    }
    throw new InvalidArgumentError(
      formatPatchNotFoundError(identifier, manifest.patches),
      identifier
    );
  }
}

/**
 * Refuses a path flag value that names no changed file in engine/. Every
 * one of these flags is about a changed file (drift to expect, an unmanaged
 * file to admit, a file to adopt), so a clean or absent path is a typo or a
 * swallowed argument, and the run would otherwise treat it as a no-op.
 */
async function assertFlagPathsInStatus(
  engineDir: string,
  options: ReExportOptions,
  manifest: PatchesManifest
): Promise<void> {
  const normalize = (flag: string, values: readonly string[] | undefined): [string, string[]] => [
    flag,
    (values ?? []).map((value) => normalizeEngineRelativeInput(value, flag)),
  ];
  const expectNew = normalize('--expect-new', options.expectNew);
  const byFlag = [
    normalize('--expect', options.expect),
    normalize('--expect-unmanaged', options.expectUnmanaged),
    expectNew,
    normalize(
      '--scan-file',
      options.scanFiles?.map((value) => splitScanFileOwner(value).path)
    ),
  ];
  const all = [...new Set(byFlag.flatMap(([, values]) => values))];
  if (all.length === 0 || !(await isGitRepository(engineDir))) return;

  const changed = new Set<string>();
  try {
    for (const chunk of chunkPathspecs(all)) {
      for (const file of await getDirtyFiles(engineDir, chunk)) changed.add(file);
    }
  } catch {
    // An engine git cannot answer for (no HEAD yet, a broken checkout) is
    // the locked run's engine precondition to report, with its own remedy.
    return;
  }
  for (const [flag, values] of byFlag) {
    const absent = values.filter((value) => !changed.has(value));
    if (absent.length > 0) {
      throw new InvalidArgumentError(
        `${flag} names no changed file in engine/: ${absent.join(', ')}. Each value must be a ` +
          'path git status lists (modified, deleted or untracked); a clean or missing path is a ' +
          'typo or a list that ended early, and the run would have ignored it.',
        flag
      );
    }
  }

  const owners = new Map<string, string>();
  for (const patch of manifest.patches) {
    for (const file of patch.filesAffected) owners.set(file, patch.filename);
  }
  const owned = expectNew[1].filter((file) => owners.has(file));
  if (owned.length > 0) {
    throw new InvalidArgumentError(
      `--expect-new names a file a patch already owns: ` +
        `${owned.map((file) => `${file} (${owners.get(file) ?? ''})`).join(', ')}. ` +
        '--expect-new is for files no patch owns yet; drop it for these.',
      '--expect-new'
    );
  }
}

/**
 * Runs every lock-free argument check: empty or unknown patch names
 * (naming an engine file passed by mistake), option combinations, path
 * flag values that are flags, and path flag values that name no changed
 * file. Throws the refusal the locked run would have thrown, only sooner.
 *
 * @param projectRoot - Project root
 * @param patches - Positional patch arguments as given
 * @param options - Options as the command layer builds them
 */
export async function preflightReExportArguments(
  projectRoot: string,
  patches: readonly string[],
  options: ReExportOptions
): Promise<void> {
  const empty = patches.filter((patch) => patch.trim().length === 0).length;
  if (empty > 0) {
    throw new InvalidArgumentError(
      `re-export was given ${empty} empty patch argument(s). An empty argument is usually a ` +
        'shell expansion that produced nothing (an unquoted "$@" in a heredoc, an unset ' +
        'variable); pass patch identifiers, or --all.',
      'patches'
    );
  }

  const normalized = normalizeReExportFilesPositionals(patches, options);
  validateReExportOptionCombinations(normalized.patches, normalized.options);

  const paths = getProjectPaths(projectRoot);
  const manifest = await loadPatchesManifest(paths.patches);
  // No manifest: the locked run reports that with its own remedy.
  if (!manifest || manifest.patches.length === 0) return;

  if (options.all !== true) {
    await resolvePositionals(paths.engine, normalized.patches, manifest);
  }
  await assertFlagPathsInStatus(paths.engine, normalized.options, manifest);
}
