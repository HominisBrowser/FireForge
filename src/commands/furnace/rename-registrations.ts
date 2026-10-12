// SPDX-License-Identifier: EUPL-1.2
/**
 * Engine registration edits for `furnace rename`: the customElements.js
 * entry (rewritten in place, keeping its marker comments), the
 * toolkit/content/jar.mn widget lines, the deployed `.ftl`, and the locale
 * jar.mn line (re-pointed only when one existed, never for `sharedFtl`).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../../core/config.js';
import {
  resolveFtlChromeSubPath,
  resolveFtlLocaleJarMnPath,
} from '../../core/furnace-constants.js';
import { resolveFurnaceMarkerComment } from '../../core/furnace-marker.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  addLocaleFtlJarMnEntry,
  removeCustomElementRegistration,
  removeJarMnEntries,
  removeLocaleFtlJarMnEntry,
  renameCustomElementRegistration,
} from '../../core/furnace-registration.js';
import { type RollbackJournal, snapshotFile } from '../../core/furnace-rollback.js';
import type { CustomComponentConfig } from '../../types/furnace.js';
import { pathExists, readText, removeFile, writeText } from '../../utils/fs.js';

/**
 * The project marker (`// <MARKER>:`) a registration line written by the
 * rename carries, resolved exactly as `furnace apply` resolves it. An
 * unreadable fireforge.json degrades to no marker rather than failing the
 * rename.
 */
export async function loadMarkerComment(projectRoot: string): Promise<string | undefined> {
  try {
    return resolveFurnaceMarkerComment(await loadConfig(projectRoot));
  } catch {
    return undefined;
  }
}

/** Inputs for {@link updateEngineRegistrations}. */
export interface UpdateEngineRegistrationsOptions {
  /** Absolute path to the engine checkout. */
  engineDir: string;
  /** Tag name being renamed away from. */
  oldName: string;
  /** Tag name being renamed to. */
  newName: string;
  /** Workspace directory holding the renamed component's files. */
  newDir: string;
  /** Engine-relative directory localized components deploy their `.ftl` into. */
  ftlDir: string;
  /** The renamed component's furnace.json entry (`localized`, `sharedFtl`). */
  componentConfig: CustomComponentConfig;
  /** Project marker for a registration line the rename has to add fresh. */
  markerComment: string | undefined;
  /** Rollback journal every write is recorded in. */
  journal: RollbackJournal;
}

/**
 * Re-points the engine-side registrations (customElements.js, jar.mn, and
 * the localized `.ftl` entries) from the old tag name to the new one.
 *
 * @param options - See {@link UpdateEngineRegistrationsOptions}
 */
export async function updateEngineRegistrations(
  options: UpdateEngineRegistrationsOptions
): Promise<void> {
  const { engineDir, oldName, newName, newDir, ftlDir, componentConfig, markerComment, journal } =
    options;
  const customElementsPath = join(engineDir, 'toolkit/content/customElements.js');
  const jarMnPath = join(engineDir, 'toolkit/content/jar.mn');

  if (await pathExists(customElementsPath)) {
    await snapshotFile(journal, customElementsPath);
    // Rewrite the existing entry in place: it keeps its position, layout and
    // trailing `// <MARKER>:` comments. Only when there is no entry to
    // rewrite is a fresh one added, carrying the project marker like every
    // line `furnace apply` writes.
    if (!(await renameCustomElementRegistration(engineDir, oldName, newName))) {
      await removeCustomElementRegistration(engineDir, oldName);
      await addCustomElementRegistration(
        engineDir,
        newName,
        `chrome://global/content/elements/${newName}.mjs`,
        markerComment !== undefined ? { markerComment } : {}
      );
    }
  }

  if (await pathExists(jarMnPath)) {
    await snapshotFile(journal, jarMnPath);
    await removeJarMnEntries(engineDir, oldName);
    const files = (await readdir(newDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.css')))
      .map((e) => e.name);
    if (files.length > 0) {
      await addJarMnEntries(engineDir, newName, files);
    }
  }

  // Rename FTL localization files in the engine locale directory
  const ftlDirPath = join(engineDir, ftlDir);
  const oldFtlPath = join(ftlDirPath, `${oldName}.ftl`);
  const newFtlPath = join(ftlDirPath, `${newName}.ftl`);
  if (await pathExists(oldFtlPath)) {
    await snapshotFile(journal, oldFtlPath);
    await snapshotFile(journal, newFtlPath);
    const ftlContent = await readText(oldFtlPath);
    await writeText(newFtlPath, ftlContent);
    await removeFile(oldFtlPath);
  }

  // Re-point the locale jar.mn chrome registration when the component is
  // localized. Renaming the .ftl file on disk alone leaves the locale
  // jar.mn pointing at `locale/.../${oldName}.ftl`, so `furnace validate`
  // passes while the engine still carries a stale registration for the
  // now-missing file. Only an existing line is re-pointed: a `sharedFtl`
  // component has no per-component .ftl, and adding a line for one names a
  // file that does not exist (an unmanaged edit `mach build` trips over).
  if (componentConfig.localized) {
    const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
    const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
    if (chromeSubPath !== undefined && localeJarRel !== undefined) {
      const localeJarAbs = join(engineDir, localeJarRel);
      if (await pathExists(localeJarAbs)) {
        await snapshotFile(journal, localeJarAbs);
        const removed = await removeLocaleFtlJarMnEntry(
          engineDir,
          localeJarRel,
          oldName,
          chromeSubPath
        );
        if (removed && componentConfig.sharedFtl === undefined) {
          await addLocaleFtlJarMnEntry(engineDir, localeJarRel, newName, chromeSubPath);
        }
      }
    }
  }
}
