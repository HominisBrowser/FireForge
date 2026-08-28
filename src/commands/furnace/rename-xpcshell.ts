// SPDX-License-Identifier: EUPL-1.2
/**
 * xpcshell scaffold rename helper extracted from `rename.ts`.
 *
 * `furnace create --with-tests --xpcshell` writes a scaffold at
 * `browser/base/content/test/<binary>-xpcshell/<name>/`, which a rename must
 * follow. This helper renames the directory, updates the test filename,
 * rewrites the `xpcshell.toml` section header, and re-writes the test body
 * so word-boundary occurrences of the old tag / underscored name map to the
 * new ones.
 *
 * Extracted to keep `rename.ts` under the per-file LOC budget — it already
 * carries mochikit + browser-mochitest + FTL handling.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../../core/config.js';
import { xpcshellTestParentDir } from '../../core/furnace-constants.js';
import {
  recordCreatedDir,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { toError } from '../../utils/errors.js';
import {
  ensureDir,
  pathExists,
  readText,
  removeDir,
  removeFile,
  writeText,
} from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { escapeRegex } from '../../utils/regex.js';

/**
 * Renames an xpcshell test scaffold in place. Moves the directory,
 * rewrites the test filename, updates the `[test_name]` section header
 * in `xpcshell.toml`, and word-boundary-rewrites occurrences of the
 * old tag / old underscored name inside the test body.
 *
 * Best-effort: any failure logs a warning through the shared logger
 * but never throws — the component rename itself has already succeeded
 * at this point, and blocking on a test rewrite would leave the
 * operator with a half-renamed component.
 *
 * @param engineDir - Absolute path to the engine directory under the project.
 * @param projectRoot - Absolute path to the project root, used to load the binary name.
 * @param oldName - Pre-rename component tag name.
 * @param newName - Post-rename component tag name.
 * @param journal - Rollback journal that the rename mutation writes to before touching files.
 */
export async function renameXpcshellTestFiles(
  engineDir: string,
  projectRoot: string,
  oldName: string,
  newName: string,
  journal: RollbackJournal
): Promise<void> {
  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch {
    return; // Cannot determine scaffold path without config.
  }

  const parentDir = join(engineDir, xpcshellTestParentDir(forgeConfig.binaryName));
  if (!(await pathExists(parentDir))) return;

  const oldScaffoldDir = join(parentDir, oldName);
  const newScaffoldDir = join(parentDir, newName);
  if (!(await pathExists(oldScaffoldDir))) return;

  const oldUnderscored = oldName.replace(/-/g, '_');
  const newUnderscored = newName.replace(/-/g, '_');
  const oldTestFileName = `test_${oldUnderscored}_packaged.js`;
  const newTestFileName = `test_${newUnderscored}_packaged.js`;

  try {
    // Journal the new scaffold dir + files so rollback (including the
    // SIGINT path) removes them; only the old-name files were journaled
    // before, so a failed rename stranded the new-name scaffold.
    recordCreatedDir(journal, newScaffoldDir);
    await ensureDir(newScaffoldDir);
    const entries = await readdir(oldScaffoldDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const oldFilePath = join(oldScaffoldDir, entry.name);
      const renamedFileName = entry.name === oldTestFileName ? newTestFileName : entry.name;
      const newFilePath = join(newScaffoldDir, renamedFileName);
      await snapshotFile(journal, oldFilePath);
      await snapshotFile(journal, newFilePath);

      const body = await readText(oldFilePath);
      let updated = body;
      if (entry.name === 'xpcshell.toml') {
        updated = updated.replace(
          new RegExp(`\\[${escapeRegex(`"${oldTestFileName}"`)}\\]`, 'g'),
          `["${newTestFileName}"]`
        );
      } else if (entry.name === oldTestFileName) {
        const oldTagPattern = new RegExp(`(?<![\\w-])${escapeRegex(oldName)}(?![\\w-])`, 'g');
        updated = updated.replace(oldTagPattern, newName);
        const oldUnderscoredPattern = new RegExp(
          `(?<![\\w])${escapeRegex(oldUnderscored)}(?![\\w])`,
          'g'
        );
        updated = updated.replace(oldUnderscoredPattern, newUnderscored);
      }

      await writeText(newFilePath, updated);
      await removeFile(oldFilePath);
    }
    await removeDir(oldScaffoldDir);
    info(
      `Renamed xpcshell scaffold directory: ${xpcshellTestParentDir(forgeConfig.binaryName)}/${oldName} → ${xpcshellTestParentDir(forgeConfig.binaryName)}/${newName}`
    );
  } catch (error: unknown) {
    warn(
      `Could not rename xpcshell scaffold — ${toError(error).message}. Rename the scaffold files manually if needed.`
    );
  }
}
