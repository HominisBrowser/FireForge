// SPDX-License-Identifier: EUPL-1.2
/**
 * The registration arm of the scan-less re-export adjacency belt.
 *
 * A file the patch registers (a jar.mn, moz.build or test-manifest line the
 * patch adds names it) belongs with the patch even when it lives in another
 * directory, so an unmanaged one is adjacent in the sense that matters: the
 * refreshed body would ship a registration for a file it leaves out. This
 * module answers which changed engine files those lines name. The caller
 * filters out owned, claimed and tool-managed paths.
 *
 * Split out of re-export-adjacent.ts to keep that module about the
 * classification, not the carrier parsing.
 */
import { dirname } from 'node:path';

import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import {
  getDirtyFiles,
  getModifiedFilesInDir,
  getUntrackedFilesInDir,
} from '../core/git-status.js';
import { extractAddedLinesPerFile } from '../core/patch-lint-diff.js';
import {
  isRegistrationCarrier,
  resolveCarrierReferences,
} from '../core/patch-lint-forward-registration-extended.js';
import { normalizePathSlashes } from '../utils/paths.js';

/** One changed engine file a registration line the patch adds names. */
export interface RegisteredChangedFile {
  /** Engine-relative path of the named file. */
  file: string;
  /** Engine-relative path of the carrier whose added line names it. */
  carrier: string;
}

/**
 * Lists the changed (modified, deleted or untracked) engine files named by
 * the registration lines the patch's owned carriers add relative to HEAD.
 * Only added lines count: an upstream line naming an upstream file is not
 * the patch's registration. A wildcard token is matched against the changed
 * files under its carrier's directory, the only place such a token reaches
 * without the build system.
 *
 * @param engineDir - Engine checkout
 * @param ownedFiles - The patch's current filesAffected
 * @returns Named changed files, first carrier wins, sorted by path
 */
export async function findRegisteredChangedFiles(
  engineDir: string,
  ownedFiles: readonly string[]
): Promise<RegisteredChangedFile[]> {
  const carriers = ownedFiles.filter(isRegistrationCarrier);
  if (carriers.length === 0) return [];

  const diff = await getDiffForFilesAgainstHead(engineDir, carriers);
  const exactToCarrier = new Map<string, string>();
  const wildcardsByCarrier = new Map<string, ((candidate: string) => boolean)[]>();
  for (const [carrier, lines] of extractAddedLinesPerFile(diff)) {
    for (const ref of resolveCarrierReferences(carrier, lines.join('\n'))) {
      if (ref.exact !== undefined) {
        if (!exactToCarrier.has(ref.exact)) exactToCarrier.set(ref.exact, carrier);
      } else {
        const list = wildcardsByCarrier.get(carrier) ?? [];
        list.push(ref.matches);
        wildcardsByCarrier.set(carrier, list);
      }
    }
  }

  const found = new Map<string, string>();
  if (exactToCarrier.size > 0) {
    for (const file of await getDirtyFiles(engineDir, [...exactToCarrier.keys()])) {
      const carrier = exactToCarrier.get(file);
      if (carrier !== undefined) found.set(file, carrier);
    }
  }
  for (const [carrier, matchers] of wildcardsByCarrier) {
    const scope = normalizePathSlashes(dirname(carrier));
    const [modified, untracked] = await Promise.all([
      getModifiedFilesInDir(engineDir, scope),
      getUntrackedFilesInDir(engineDir, scope),
    ]);
    for (const file of [...modified, ...untracked]) {
      if (!found.has(file) && matchers.some((matches) => matches(file))) found.set(file, carrier);
    }
  }

  return [...found.entries()]
    .map(([file, carrier]) => ({ file, carrier }))
    .sort((a, b) => a.file.localeCompare(b.file));
}
