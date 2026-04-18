// SPDX-License-Identifier: EUPL-1.2
/**
 * `.ftl` apply/undeploy helpers for custom components. Extracted from
 * `furnace-apply-helpers.ts` so the main helper module stays under the
 * per-file LOC budget.
 *
 * Every helper here degrades gracefully: if the locale jar.mn is missing or
 * the FTL tree is non-standard, apply logs a `stepError` rather than
 * aborting the whole command. Missing jar.mn on a fork without a locale
 * package should not block a working `.mjs`/`.css` from shipping.
 */

import { join, relative } from 'node:path';

import type { DryRunAction, StepError } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { copyFile, pathExists } from '../utils/fs.js';
import { resolveFtlChromeSubPath, resolveFtlLocaleJarMnPath } from './furnace-constants.js';
import { addLocaleFtlJarMnEntry, removeLocaleFtlJarMnEntry } from './furnace-registration.js';
import { type RollbackJournal, snapshotFile } from './furnace-rollback.js';

/**
 * Copies a component's `.ftl` into the FTL tree and registers the chrome URI
 * in the locale jar.mn.
 *
 * Failure modes (missing jar.mn, regex write error) are captured as
 * stepErrors rather than thrown — a well-formed `.mjs`/`.css` must never be
 * blocked by a broken locale path.
 */
export async function applyCustomFtlFile(
  engineDir: string,
  name: string,
  componentDir: string,
  ftlDir: string,
  affectedPaths: string[],
  stepErrors: StepError[],
  rollbackJournal?: RollbackJournal
): Promise<void> {
  const ftlFile = `${name}.ftl`;
  const ftlSrc = join(componentDir, ftlFile);
  if (!(await pathExists(ftlSrc))) return;

  const ftlDest = join(engineDir, ftlDir, ftlFile);
  if (rollbackJournal) {
    await snapshotFile(rollbackJournal, ftlDest);
  }
  await copyFile(ftlSrc, ftlDest);
  affectedPaths.push(relative(engineDir, ftlDest));

  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
  if (chromeSubPath === undefined || localeJarRel === undefined) return;

  const localeJarAbs = join(engineDir, localeJarRel);
  if (!(await pathExists(localeJarAbs))) {
    stepErrors.push({
      step: 'locale jar.mn registration',
      error: `Locale jar.mn not found at ${localeJarRel}; component "${name}" ships without a chrome URI for ${ftlFile}. Add the file manually or set furnace.json "ftlBasePath" to a tree that owns a jar.mn.`,
    });
    return;
  }

  try {
    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, localeJarAbs);
    }
    const inserted = await addLocaleFtlJarMnEntry(engineDir, localeJarRel, name, chromeSubPath);
    if (inserted > 0) {
      affectedPaths.push(localeJarRel);
    }
  } catch (error: unknown) {
    stepErrors.push({
      step: 'locale jar.mn registration',
      error: toError(error).message,
    });
  }
}

/**
 * Returns a dry-run action for registering a locale jar.mn entry for the
 * `.ftl` that `applyCustomFtlFile` would write. `undefined` when the FTL
 * tree does not expose a locale jar.mn we can confidently name.
 */
export function describeLocaleFtlJarMnRegistration(
  name: string,
  ftlDir: string,
  ftlFile: string
): DryRunAction | undefined {
  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
  if (chromeSubPath === undefined || localeJarRel === undefined) return undefined;
  return {
    component: name,
    action: 'register-jar',
    description: `Register ${chromeSubPath}/${ftlFile} in ${localeJarRel}`,
  };
}

/**
 * Drops the locale jar.mn entry for `fileName` when it's a `.ftl` whose
 * source workspace file has been deleted. Idempotent — absent entries are a
 * no-op.
 */
export async function removeCustomFtlJarMnEntry(
  engineDir: string,
  fileName: string,
  ftlDir: string,
  rollbackJournal?: RollbackJournal
): Promise<void> {
  if (!fileName.endsWith('.ftl')) return;
  const tagName = fileName.slice(0, -'.ftl'.length);
  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
  if (chromeSubPath === undefined || localeJarRel === undefined) return;

  const localeJarAbs = join(engineDir, localeJarRel);
  if (!(await pathExists(localeJarAbs))) return;

  if (rollbackJournal) {
    await snapshotFile(rollbackJournal, localeJarAbs);
  }
  await removeLocaleFtlJarMnEntry(engineDir, localeJarRel, tagName, chromeSubPath);
}
