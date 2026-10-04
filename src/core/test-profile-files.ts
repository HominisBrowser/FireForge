// SPDX-License-Identifier: EUPL-1.2
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { InvalidArgumentError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { warn } from '../utils/logger.js';

/** Stages explicit profile overlays with relative destinations; cleanup belongs to the caller. */
export interface StagedProfileFiles {
  root: string;
  args: string[];
  env: Record<string, string>;
}

/** Prepares profile overlays and browser/port ownership preconditions. */
export async function stageProfileFiles(
  projectRoot: string,
  files: readonly string[]
): Promise<StagedProfileFiles> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-profile-overlay-'));
  const top = new Set<string>();
  try {
    for (const file of files) {
      const separator = file.indexOf('=');
      const source = file.slice(0, separator);
      const dest = file.slice(separator + 1).replaceAll('\\', '/');
      if (
        separator <= 0 ||
        !dest ||
        dest.startsWith('/') ||
        dest.includes(':') ||
        dest.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        throw new InvalidArgumentError(
          '--profile-file requires source=relative/destination with no traversal.',
          '--profile-file'
        );
      }
      const target = join(root, dest);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(projectRoot, source), target);
      top.add(dest.split('/')[0] ?? dest);
    }
    return {
      root,
      args: [...top].map((path) => `--extra-profile-file=${join(root, path)}`),
      env: { FIREFORGE_PROFILE_MERGE_ROOT: root },
    };
  } catch (error: unknown) {
    await cleanupProfileFiles(root);
    throw error;
  }
}

/** Python startup overlay: allow merging ONLY the explicitly staged profile directories. */
export const PROFILE_MERGE_PYTHON = `
import os
import shutil
_fireforge_profile_root = os.environ.get("FIREFORGE_PROFILE_MERGE_ROOT")
if _fireforge_profile_root and not getattr(shutil.copytree, "_fireforge_profile_merge", False):
    _fireforge_copytree = shutil.copytree
    def _fireforge_merge_copytree(src, dst, *args, **kwargs):
        if os.path.realpath(src).startswith(os.path.realpath(_fireforge_profile_root) + os.sep):
            # Python's recursive calls may supply dirs_exist_ok positionally.
            if len(args) >= 5:
                args = args[:4] + (True,) + args[5:]
            else:
                kwargs["dirs_exist_ok"] = True
        return _fireforge_copytree(src, dst, *args, **kwargs)
    _fireforge_merge_copytree._fireforge_profile_merge = True
    shutil.copytree = _fireforge_merge_copytree
`;

/** Classifies the profile setup traceback separately from stale packaging. */
export function classifyProfileArgumentFailure(
  output: string
): { kind: 'harness-arguments'; note: string } | undefined {
  if (!/copyExtraFilesToProfile/.test(output) || !/FileExistsError/.test(output)) return undefined;
  return {
    kind: 'harness-arguments',
    note: 'profile directory collision; use --profile-file source=chrome/userChrome.css to merge into the existing profile',
  };
}

/** Cleanup is independent of the harness verdict and cannot hide its primary error. */
export async function cleanupProfileFiles(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error: unknown) {
    warn(`Could not remove staged profile files ${root}: ${toError(error).message}`);
  }
}
