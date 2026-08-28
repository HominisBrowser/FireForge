// SPDX-License-Identifier: EUPL-1.2
/**
 * `.ftl` apply/undeploy helpers for custom components. Extracted from
 * `furnace-apply-helpers.ts` so the main helper module stays under the
 * per-file LOC budget.
 *
 * Every helper here degrades gracefully: if the locale jar.mn is missing or
 * the FTL tree is non-standard, apply logs an ADVISORY `stepError`
 * (`advisory: true`) rather than aborting the whole command. Advisory step
 * errors are reported as warnings and never trigger rollback — a missing
 * jar.mn on a fork without a locale package must not block a working
 * `.mjs`/`.css` from shipping.
 */

import { join, relative } from 'node:path';

import type {
  ComponentApplyContext,
  CustomComponentConfig,
  DryRunAction,
  StepError,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { copyFile, pathExists, readText } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import { resolveFtlChromeSubPath, resolveFtlLocaleJarMnPath } from './furnace-constants.js';
import { addLocaleFtlJarMnEntry, removeLocaleFtlJarMnEntry } from './furnace-registration.js';
import { type RollbackJournal, snapshotFile } from './furnace-rollback.js';

/**
 * Builds the presence regex for a per-widget locale jar.mn line
 * (`locale/@AB_CD@/<chromeSubPath>/<tagName>.ftl`). Shared by the prune
 * helper and its dry-run describer so both agree on what "dangling" means.
 */
function perWidgetLocaleEntryPattern(chromeSubPath: string, tagName: string): RegExp {
  return new RegExp(
    `locale\\/(?:@AB_CD@|[a-zA-Z-]+)\\/${escapeRegex(chromeSubPath)}\\/${escapeRegex(tagName)}\\.ftl`,
    'm'
  );
}

/**
 * Resolves the engine-relative locale jar.mn and the per-widget entry regex
 * for a `sharedFtl` widget, or `undefined` when the FTL tree exposes no
 * locale jar.mn we can confidently name.
 */
function resolveSharedFtlPruneTarget(
  name: string,
  ftlDir: string
): { localeJarRel: string; pattern: RegExp } | undefined {
  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
  if (chromeSubPath === undefined || localeJarRel === undefined) return undefined;
  return { localeJarRel, pattern: perWidgetLocaleEntryPattern(chromeSubPath, name) };
}

/**
 * Removes a dangling per-widget locale jar.mn entry for a `sharedFtl` widget.
 *
 * A `localized: true` widget that opts into a feature-scoped `sharedFtl`
 * bundle (its strings live under `browser/...` and load via
 * `insertFTLIfNeeded`) must NOT carry a per-widget
 * `locale/@AB_CD@/<chromeSubPath>/<name>.ftl` line. Such a line points at a
 * `.ftl` that does not exist, so `mach build` fails hard (`Cannot find
 * <chromeSubPath>/<name>.ftl`) and blocks every build.
 *
 * The pruned line is the per-widget toolkit entry only; the shared bundle's
 * own line (a different chrome sub-path / base name) is never matched, so
 * pruning one widget cannot orphan the shared bundle. Idempotent: when no
 * dangling entry exists the file is left untouched (no journal churn).
 * Returns the engine-relative jar.mn path when a line was removed, else
 * `undefined`.
 */
async function pruneSharedFtlPerWidgetLocaleEntry(
  engineDir: string,
  name: string,
  ftlDir: string,
  config: CustomComponentConfig,
  rollbackJournal?: RollbackJournal
): Promise<string | undefined> {
  if (!config.sharedFtl) return undefined;
  const target = resolveSharedFtlPruneTarget(name, ftlDir);
  if (!target) return undefined;

  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  if (chromeSubPath === undefined) return undefined;

  const localeJarAbs = join(engineDir, target.localeJarRel);
  if (!(await pathExists(localeJarAbs))) return undefined;
  if (!target.pattern.test(await readText(localeJarAbs))) return undefined;

  if (rollbackJournal) {
    await snapshotFile(rollbackJournal, localeJarAbs);
  }
  await removeLocaleFtlJarMnEntry(engineDir, target.localeJarRel, name, chromeSubPath);
  return target.localeJarRel;
}

/**
 * Apply-path wrapper around {@link pruneSharedFtlPerWidgetLocaleEntry} that
 * records the affected path / step error in the caller's collectors, mirroring
 * {@link applyCustomFtlFile}'s contract so the main apply helper stays terse.
 */
export async function applySharedFtlPrune(
  ctx: Pick<ComponentApplyContext, 'engineDir' | 'name' | 'ftlDir'>,
  config: CustomComponentConfig,
  affectedPaths: string[],
  stepErrors: StepError[],
  rollbackJournal?: RollbackJournal
): Promise<void> {
  const { engineDir, name, ftlDir } = ctx;
  try {
    const prunedPath = await pruneSharedFtlPerWidgetLocaleEntry(
      engineDir,
      name,
      ftlDir,
      config,
      rollbackJournal
    );
    if (prunedPath) affectedPaths.push(prunedPath);
  } catch (error: unknown) {
    stepErrors.push({ step: 'locale jar.mn prune', error: toError(error).message, advisory: true });
  }
}

/**
 * Read-only dry-run describer for {@link pruneSharedFtlPerWidgetLocaleEntry}:
 * returns an action when a dangling per-widget locale entry exists for a
 * `sharedFtl` widget, else `undefined`.
 */
export async function describeSharedFtlPrune(
  ctx: Pick<ComponentApplyContext, 'engineDir' | 'name' | 'ftlDir'>,
  config: CustomComponentConfig
): Promise<DryRunAction | undefined> {
  const { engineDir, name, ftlDir } = ctx;
  if (!config.sharedFtl) return undefined;
  const target = resolveSharedFtlPruneTarget(name, ftlDir);
  if (!target) return undefined;

  const localeJarAbs = join(engineDir, target.localeJarRel);
  if (!(await pathExists(localeJarAbs))) return undefined;
  if (!target.pattern.test(await readText(localeJarAbs))) return undefined;

  return {
    component: name,
    action: 'register-jar',
    description: `Remove dangling per-widget locale entry for ${name} from ${target.localeJarRel} (sharedFtl bundle owns its strings)`,
  };
}

/**
 * Copies a component's `.ftl` into the FTL tree and registers the chrome URI
 * in the locale jar.mn.
 *
 * Failure modes (missing jar.mn, regex write error) are captured as
 * stepErrors rather than thrown — a well-formed `.mjs`/`.css` must never be
 * blocked by a broken locale path.
 */
export async function applyCustomFtlFile(
  ctx: Pick<ComponentApplyContext, 'engineDir' | 'name' | 'componentDir' | 'ftlDir'>,
  affectedPaths: string[],
  stepErrors: StepError[],
  rollbackJournal?: RollbackJournal
): Promise<void> {
  const { engineDir, name, componentDir, ftlDir } = ctx;
  const ftlFile = `${name}.ftl`;
  const ftlSrc = join(componentDir, ftlFile);
  if (!(await pathExists(ftlSrc))) return;

  const ftlDest = join(engineDir, ftlDir, ftlFile);
  if (rollbackJournal) {
    await snapshotFile(rollbackJournal, ftlDest);
  }
  await copyFile(ftlSrc, ftlDest);
  // Sibling pushes on this list are POSIX literals (`localeJarRel`); keep
  // the computed one in the same spelling.
  affectedPaths.push(normalizePathSlashes(relative(engineDir, ftlDest)));

  const chromeSubPath = resolveFtlChromeSubPath(ftlDir);
  const localeJarRel = resolveFtlLocaleJarMnPath(ftlDir);
  if (chromeSubPath === undefined || localeJarRel === undefined) return;

  const localeJarAbs = join(engineDir, localeJarRel);
  if (!(await pathExists(localeJarAbs))) {
    stepErrors.push({
      step: 'locale jar.mn registration',
      error: `Locale jar.mn not found at ${localeJarRel}; component "${name}" ships without a chrome URI for ${ftlFile}. Add the file manually or set furnace.json "ftlBasePath" to a tree that owns a jar.mn.`,
      advisory: true,
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
      advisory: true,
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
 * no-op. Early-returns for `sharedFtl` components: the shared bundle is
 * owned elsewhere, and dropping its jar.mn line on our component's delete
 * would orphan every other participant.
 */
export async function removeCustomFtlJarMnEntry(
  engineDir: string,
  fileName: string,
  ftlDir: string,
  config: CustomComponentConfig,
  rollbackJournal?: RollbackJournal
): Promise<void> {
  if (config.sharedFtl) return;
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
