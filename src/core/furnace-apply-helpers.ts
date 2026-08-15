// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type {
  CustomComponentConfig,
  DryRunAction,
  OverrideComponentConfig,
  StepError,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { copyFile, ensureDir, pathExists, readText, removeFile } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { buildCustomDryRunActions } from './furnace-apply-dry-run.js';
import {
  applyCustomFtlFile,
  applySharedFtlPrune,
  removeCustomFtlJarMnEntry,
} from './furnace-apply-ftl.js';
import { CUSTOM_ELEMENTS_JS, JAR_MN } from './furnace-constants.js';
import { deployFileWithFragments, SHARED_FRAGMENTS_DIR } from './furnace-css-fragments.js';
import { addCustomElementRegistration, addJarMnEntries } from './furnace-registration.js';
import { recordCreatedDir, type RollbackJournal, snapshotFile } from './furnace-rollback.js';
import { checkRegistrationConsistency } from './furnace-validate-registration.js';
import { isGitRepository } from './git.js';
import { fileExistsInHead, restoreTrackedPath } from './git-file-ops.js';

interface DirectoryEntry {
  isFile(): boolean;
  isSymbolicLink?(): boolean;
  name: string;
}

/**
 * True for a plain-file directory entry — symlinks and directories are
 * never copy candidates. Exported for the patch-owned overwrite probe
 * (FORGE J6), which walks the same override copy-candidate set as apply.
 */
export function isRegularFile(entry: DirectoryEntry): boolean {
  if (!entry.isFile()) return false;
  if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) return false;
  return true;
}

function isChecksummedComponentFile(name: string): boolean {
  return name.endsWith('.mjs') || name.endsWith('.css') || name.endsWith('.ftl');
}

/**
 * Filter deciding which files in an override workspace directory are candidates
 * for copying into the engine. Exported so `furnace remove` can invert apply
 * using the exact same file set — the "files to restore" set is defined as the
 * inverse of the "files apply would have written" set.
 */
export function isOverrideCopyCandidate(
  entryName: string,
  type: OverrideComponentConfig['type']
): boolean {
  if (entryName === 'override.json') {
    return false;
  }

  if (type === 'css-only') {
    return entryName.endsWith('.css');
  }

  return entryName.endsWith('.mjs') || entryName.endsWith('.css') || entryName.endsWith('.ftl');
}

/** Resolves the engine destination path for a single override-managed file. */
export function getOverrideEngineTargetPath(
  engineDir: string,
  config: OverrideComponentConfig,
  fileName: string,
  ftlDir: string
): string {
  return fileName.endsWith('.ftl')
    ? join(engineDir, ftlDir, fileName)
    : join(engineDir, config.basePath, fileName);
}

/**
 * Restores a single override-deployed engine file to its pristine HEAD state,
 * inverting whatever apply wrote into that path.
 *
 * Behaviour matches the per-file branch of `restoreOverrideEngineFiles` in
 * `furnace remove`: snapshot first, then either `git restore` (if the file
 * exists in HEAD) or hard-delete (if the override introduced the file). The
 * caller MUST guarantee `engineDir` is a git repository — this helper does
 * not re-check, because both `furnace remove` and `furnace apply` already
 * own the precondition check at their entry points and re-checking on every
 * file would balloon git invocations.
 *
 * Returns the action taken so the caller can produce accurate user-facing
 * counts (`restored` vs `removed`). `noop` means the file was neither in HEAD
 * nor on disk, which can happen when the engine was reset out-of-band — the
 * caller should treat that as a successful no-op rather than an error.
 */
export async function restoreOverrideFileToBaseline(
  engineDir: string,
  enginePath: string,
  journal: RollbackJournal
): Promise<'restored' | 'removed' | 'noop'> {
  const relPath = relative(engineDir, enginePath);

  // Snapshot before mutation so a later rollback can undo both restoration
  // (writes whatever content we removed back) and deletion (recreates the
  // file). Snapshotting a missing path records `{ existed: false }`, which
  // restoreFile turns into a delete — exactly the inverse of "we just
  // wrote a file here", which is correct for the noop case too.
  await snapshotFile(journal, enginePath);

  if (await fileExistsInHead(engineDir, relPath)) {
    await restoreTrackedPath(engineDir, relPath);
    return 'restored';
  }

  if (await pathExists(enginePath)) {
    await removeFile(enginePath);
    return 'removed';
  }

  return 'noop';
}

/** Computes stable checksums for the source files that define a component. */
export async function computeComponentChecksums(
  componentDir: string
): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });

  for (const entry of entries) {
    if (!isRegularFile(entry)) continue;
    if (entry.name === 'override.json') continue;
    if (!isChecksummedComponentFile(entry.name)) continue;

    const content = await readText(join(componentDir, entry.name));
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(normalized).digest('hex');
    checksums[entry.name] = hash;
  }

  return checksums;
}

/**
 * Removes engine copies of files that the developer has deleted from a custom
 * component's workspace since the last apply. `.ftl` files live under the
 * shared Fluent tree (`engine/${FTL_DIR}`); everything else lives under
 * `engine/${config.targetPath}`. Snapshots each removal into the journal so a
 * mid-apply failure can roll the engine back to its pre-undeploy state. Files
 * that are already missing from the engine are silently no-op (the engine
 * may have been reset out-of-band — refusing here would surface a confusing
 * error in a recovery path).
 *
 * Does **not** touch jar.mn or customElements.js: registration churn is the
 * caller's responsibility, since it must coordinate with the new file list
 * computed by the regular apply step that follows.
 */
export async function undeployCustomFiles(
  engineDir: string,
  config: CustomComponentConfig,
  deletedFiles: string[],
  ftlDir: string,
  rollbackJournal?: RollbackJournal
): Promise<string[]> {
  const removed: string[] = [];
  for (const fileName of deletedFiles) {
    const enginePath = fileName.endsWith('.ftl')
      ? join(engineDir, ftlDir, fileName)
      : join(engineDir, config.targetPath, fileName);

    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, enginePath);
    }

    if (await pathExists(enginePath)) {
      await removeFile(enginePath);
      removed.push(relative(engineDir, enginePath));
    }

    // When an `.ftl` is deleted from the workspace the corresponding locale
    // jar.mn entry must also be dropped — otherwise the chrome URI points at
    // a missing file and runtime Fluent resolution breaks silently.
    // `removeCustomFtlJarMnEntry` early-returns for `sharedFtl` components
    // (the shared bundle is owned elsewhere).
    await removeCustomFtlJarMnEntry(engineDir, fileName, ftlDir, config, rollbackJournal);
  }
  return removed;
}

/**
 * Restores or removes engine copies of files that the developer has deleted
 * from an override component's workspace since the last apply. Each file is
 * routed through `restoreOverrideFileToBaseline`, which restores it from
 * HEAD if it was a Firefox baseline file or hard-deletes it if the override
 * had introduced it.
 *
 * Requires `engineDir` to be a git repository — overrides cannot be inverted
 * without git HEAD as the source of truth. The caller is expected to have
 * already validated this precondition for the apply path; we re-check here
 * so unit tests that exercise this helper directly cannot accidentally
 * silent-fail on a non-git fixture.
 */
export async function undeployOverrideFiles(
  engineDir: string,
  config: OverrideComponentConfig,
  deletedFiles: string[],
  ftlDir: string,
  rollbackJournal?: RollbackJournal
): Promise<{ restored: string[]; removed: string[] }> {
  if (deletedFiles.length === 0) {
    return { restored: [], removed: [] };
  }

  if (!rollbackJournal) {
    throw new FurnaceError(
      'Internal: undeployOverrideFiles requires a rollback journal so deletions can be undone on failure.'
    );
  }

  if (!(await isGitRepository(engineDir))) {
    throw new FurnaceError(
      'Cannot undeploy override files: engine is not a git repository. Run "fireforge download" to initialise it.'
    );
  }

  // Note: we deliberately do not re-filter `deletedFiles` through
  // `isOverrideCopyCandidate(fileName, config.type)`. A file recorded in
  // `previous` was already a valid copy candidate when it was deployed, and
  // re-filtering would block cleanup if the override type later flipped
  // from `full` to `css-only` — exactly the case we need cleanup for.
  const restored: string[] = [];
  const removed: string[] = [];
  for (const fileName of deletedFiles) {
    const enginePath = getOverrideEngineTargetPath(engineDir, config, fileName, ftlDir);
    const action = await restoreOverrideFileToBaseline(engineDir, enginePath, rollbackJournal);
    const relPath = relative(engineDir, enginePath);
    if (action === 'restored') restored.push(relPath);
    else if (action === 'removed') removed.push(relPath);
  }
  return { restored, removed };
}

/** Compares current component file checksums against the previously recorded state. */
export async function hasComponentChanged(
  componentDir: string,
  previousChecksums: Record<string, string>,
  currentChecksums?: Record<string, string>
): Promise<boolean> {
  const current = currentChecksums ?? (await computeComponentChecksums(componentDir));
  return componentChecksumsChanged(current, previousChecksums);
}

/** Pure checksum-map comparison used when the caller already walked the component. */
function componentChecksumsChanged(
  current: Readonly<Record<string, string>>,
  previousChecksums: Readonly<Record<string, string>>
): boolean {
  const currentKeys = Object.keys(current);
  const previousKeys = Object.keys(previousChecksums);

  if (currentKeys.length !== previousKeys.length) {
    return true;
  }

  for (const key of currentKeys) {
    if (current[key] !== previousChecksums[key]) {
      return true;
    }
  }

  return false;
}

function normalizeForChecksum(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/**
 * Detects whether an override component's deployed files are missing from the
 * engine or differ from the source. Used as a guard before skipping apply on a
 * checksum match, so that reset/download/manual engine edits do not leave the
 * caller with a stale "up to date" report.
 *
 * When `cachedEngineChecksums` is provided (populated on last successful apply),
 * the function computes a SHA-256 hash of the engine file and compares it
 * against the cached value. This avoids reading the full workspace source for
 * the comparison when the engine hash still matches, which is the common case
 * for projects with many components.
 */
export async function hasOverrideEngineDrift(
  engineDir: string,
  componentDir: string,
  config: OverrideComponentConfig,
  ftlDir: string,
  cachedEngineChecksums?: Record<string, string>
): Promise<boolean> {
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });
  for (const entry of entries) {
    if (!isRegularFile(entry)) continue;
    if (!isOverrideCopyCandidate(entry.name, config.type)) continue;

    const enginePath = getOverrideEngineTargetPath(engineDir, config, entry.name, ftlDir);
    if (!(await pathExists(enginePath))) {
      return true;
    }

    const engineContent = normalizeForChecksum(await readText(enginePath));

    // Fast path: compare engine content hash against cached value from last apply
    if (cachedEngineChecksums) {
      const engineHash = createHash('sha256').update(engineContent).digest('hex');
      const cachedHash = cachedEngineChecksums[entry.name];
      if (cachedHash && engineHash !== cachedHash) {
        return true;
      }
      if (cachedHash) continue; // Hash match — skip full source comparison
    }

    // Slow path: byte-compare engine content against workspace source
    const srcContent = normalizeForChecksum(await readText(join(componentDir, entry.name)));
    if (srcContent !== engineContent) {
      return true;
    }
  }
  return false;
}

/**
 * Detects whether a custom component's deployed copies, jar.mn entries, or
 * customElements.js registration are missing from the engine or out of sync.
 * Delegates to `checkRegistrationConsistency` so the oracle stays aligned with
 * the validate command.
 */
export async function hasCustomEngineDrift(
  root: string,
  name: string,
  componentDir: string,
  config: CustomComponentConfig,
  ftlDir: string
): Promise<boolean> {
  const status = await checkRegistrationConsistency(root, name, config, ftlDir);
  if (!status.targetExists || !status.filesInSync) {
    return true;
  }
  if (status.missingTargetFiles.length > 0 || status.driftedFiles.length > 0) {
    return true;
  }
  if (!config.register) {
    return false;
  }

  // Registration drift: only check jar.mn entries for the file types that
  // actually exist in source. jarMn{Mjs,Css} are substring checks, so a
  // component with only .mjs (no .css) should not be flagged when jarMnCss
  // is false — that is the expected post-apply state, not drift.
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });
  let hasMjs = false;
  let hasCss = false;
  for (const entry of entries) {
    if (!isRegularFile(entry)) continue;
    if (entry.name.endsWith('.mjs')) hasMjs = true;
    else if (entry.name.endsWith('.css')) hasCss = true;
  }

  if (!status.customElementsPresent || !status.customElementsCorrectBlock) {
    return true;
  }
  if (hasMjs && !status.jarMnMjs) {
    return true;
  }
  if (hasCss && !status.jarMnCss) {
    return true;
  }

  return false;
}

/** Extra knobs threaded into `applyCustomComponent` from the project config. */
export interface CustomApplyOptions {
  /**
   * Trailing project marker appended to inserted `customElements.js` entries
   * (e.g. `"MYBROWSER"` emits `  // MYBROWSER:` on each line). Mirrors the
   * `markerComment` field in fireforge.json.
   */
  markerComment?: string;
}

/** Applies a custom component into the engine tree and captures registration step errors. */
export async function applyCustomComponent(
  engineDir: string,
  name: string,
  componentDir: string,
  config: CustomComponentConfig,
  ftlDir: string,
  dryRun = false,
  rollbackJournal?: RollbackJournal,
  applyOptions: CustomApplyOptions = {}
): Promise<{ affectedPaths: string[]; stepErrors: StepError[]; actions?: DryRunAction[] }> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new FurnaceError(`Invalid component name "${name}": must match /^[a-z][a-z0-9-]*$/`);
  }

  const targetDir = join(engineDir, config.targetPath);
  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });

  const customSymlinks = entries.filter(
    (e) => typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()
  );
  if (customSymlinks.length > 0) {
    verbose(
      `Skipped ${customSymlinks.length} symlink(s) in "${name}": ${customSymlinks.map((e) => e.name).join(', ')}`
    );
  }

  if (dryRun) {
    const { actions, stepErrors } = await buildCustomDryRunActions(
      name,
      componentDir,
      engineDir,
      config,
      targetDir,
      entries,
      ftlDir
    );
    return { affectedPaths: [], stepErrors, actions };
  }

  if (rollbackJournal && !(await pathExists(targetDir))) {
    recordCreatedDir(rollbackJournal, targetDir);
  }
  await ensureDir(targetDir);

  const affectedPaths: string[] = [];
  const stepErrors: StepError[] = [];
  const copiedFileNames: string[] = [];

  // Collect copy candidates, then snapshot + copy in parallel. Snapshots
  // must complete before any copy (they read the original content), but
  // independent files can be processed concurrently.
  const filesToCopy = entries.filter(
    (entry) => isRegularFile(entry) && (entry.name.endsWith('.mjs') || entry.name.endsWith('.css'))
  );

  // Snapshot phase (serial — journal is not concurrent-safe for the same path)
  for (const entry of filesToCopy) {
    const dest = join(targetDir, entry.name);
    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, dest);
    }
  }

  // Copy phase (parallel — independent file writes to different paths).
  // CSS files carrying @fireforge-include directives are written as their
  // fragment-expanded form (field report D2); the workspace source keeps
  // only the directive, so shared CSS stays single-sourced.
  const sharedDir = join(componentDir, '..', '..', SHARED_FRAGMENTS_DIR);
  await Promise.all(
    filesToCopy.map(async (entry) => {
      const src = join(componentDir, entry.name);
      const dest = join(targetDir, entry.name);
      await deployFileWithFragments(src, dest, sharedDir);
      affectedPaths.push(relative(engineDir, dest));
      copiedFileNames.push(entry.name);
    })
  );

  // See buildCustomDryRunActions for the rationale: when `sharedFtl` is set
  // the shared bundle is owned elsewhere and FireForge must not copy or
  // register a per-component `.ftl` on its behalf.
  if (config.localized && !config.sharedFtl) {
    await applyCustomFtlFile(
      engineDir,
      name,
      componentDir,
      ftlDir,
      affectedPaths,
      stepErrors,
      rollbackJournal
    );
  } else if (config.localized && config.sharedFtl) {
    // Drop any dangling per-widget locale jar.mn entry that would point at a
    // non-existent `<chromeSubPath>/<name>.ftl` and fail `mach build`. The
    // shared bundle (a different chrome path/base name) is never touched.
    await applySharedFtlPrune(
      engineDir,
      name,
      ftlDir,
      config,
      affectedPaths,
      stepErrors,
      rollbackJournal
    );
  }

  if (config.register) {
    try {
      const modulePath = `chrome://global/content/elements/${name}.mjs`;
      if (rollbackJournal) {
        await snapshotFile(rollbackJournal, join(engineDir, CUSTOM_ELEMENTS_JS));
      }
      await addCustomElementRegistration(engineDir, name, modulePath, {
        ...(applyOptions.markerComment !== undefined
          ? { markerComment: applyOptions.markerComment }
          : {}),
      });
      affectedPaths.push(CUSTOM_ELEMENTS_JS);
    } catch (error: unknown) {
      stepErrors.push({
        step: 'customElements.js registration',
        error: toError(error).message,
      });
    }
  }

  if (copiedFileNames.length > 0) {
    try {
      if (rollbackJournal) {
        await snapshotFile(rollbackJournal, join(engineDir, JAR_MN));
      }
      await addJarMnEntries(engineDir, name, copiedFileNames);
      affectedPaths.push(JAR_MN);
    } catch (error: unknown) {
      stepErrors.push({
        step: 'jar.mn registration',
        error: toError(error).message,
      });
    }
  }

  return { affectedPaths, stepErrors };
}

/** Applies an override component by copying its matching files onto the engine tree. */
export async function applyOverrideComponent(
  engineDir: string,
  name: string,
  componentDir: string,
  config: OverrideComponentConfig,
  ftlDir: string,
  dryRun = false,
  rollbackJournal?: RollbackJournal
): Promise<{ affectedPaths: string[]; actions?: DryRunAction[] }> {
  const targetDir = join(engineDir, config.basePath);

  if (!(await pathExists(targetDir))) {
    throw new FurnaceError(`Override target path not found in engine: ${config.basePath}`, name);
  }

  const entries = await readdir(componentDir, { withFileTypes: true, encoding: 'utf8' });

  const overrideSymlinks = entries.filter(
    (e) => typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()
  );
  if (overrideSymlinks.length > 0) {
    verbose(
      `Skipped ${overrideSymlinks.length} symlink(s) in "${name}": ${overrideSymlinks.map((e) => e.name).join(', ')}`
    );
  }

  if (dryRun) {
    const actions = entries
      .filter((entry) => isRegularFile(entry) && isOverrideCopyCandidate(entry.name, config.type))
      .map<DryRunAction>((entry) => ({
        component: name,
        action: 'copy',
        source: join(componentDir, entry.name),
        target: getOverrideEngineTargetPath(engineDir, config, entry.name, ftlDir),
        description: `Override ${entry.name} in ${
          entry.name.endsWith('.ftl') ? ftlDir : config.basePath
        }`,
      }));

    if (actions.length === 0) {
      throw new FurnaceError(`No matching files found in override directory for "${name}"`, name);
    }

    return { affectedPaths: [], actions };
  }

  const affectedPaths: string[] = [];
  const candidateEntries = entries.filter(
    (entry) => isRegularFile(entry) && isOverrideCopyCandidate(entry.name, config.type)
  );

  // Snapshot phase (serial)
  for (const entry of candidateEntries) {
    const dest = getOverrideEngineTargetPath(engineDir, config, entry.name, ftlDir);
    if (rollbackJournal) {
      await snapshotFile(rollbackJournal, dest);
    }
  }

  // Copy phase (parallel)
  await Promise.all(
    candidateEntries.map(async (entry) => {
      const src = join(componentDir, entry.name);
      const dest = getOverrideEngineTargetPath(engineDir, config, entry.name, ftlDir);
      await copyFile(src, dest);
      affectedPaths.push(relative(engineDir, dest));
    })
  );

  if (affectedPaths.length === 0) {
    throw new FurnaceError(`No matching files found in override directory for "${name}"`, name);
  }

  return { affectedPaths };
}

export {
  diffDeletedFiles,
  extractComponentChecksums,
  prefixChecksums,
} from './furnace-checksum-utils.js';
