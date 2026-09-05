// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths, loadState } from '../../core/config.js';
import { diffLines, renderHunks } from '../../core/diff-hunks.js';
import { getOverrideEngineTargetPath } from '../../core/furnace-apply-helpers.js';
import { getFurnacePaths, loadFurnaceConfig } from '../../core/furnace-config.js';
import { isComponentSourceFile, resolveFtlDir } from '../../core/furnace-constants.js';
import { getFileContentAtRef } from '../../core/git-file-ops.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { pathExists, readText } from '../../utils/fs.js';
import { formatErrorText, formatSuccessText, info, intro, outro } from '../../utils/logger.js';
import { normalizePathSlashes } from '../../utils/paths.js';

/**
 * Renders a multi-hunk unified diff between the two strings and returns a
 * flat list of display-ready lines. Each line has already had its marker
 * prefix and color applied by this function. The caller just emits them.
 *
 * Pure delegation to the `diff-hunks` module, kept here as a thin wrapper
 * so the command file does not need to care about the hunk data shape.
 */
function formatUnifiedDiff(original: string, modified: string): string[] {
  const hunks = diffLines(original, modified, 3);
  return renderHunks(hunks).map((line) => {
    switch (line.kind) {
      case 'removed':
        return formatErrorText(line.text);
      case 'added':
        return formatSuccessText(line.text);
      default:
        return line.text;
    }
  });
}

/**
 * Diffs an override component against its Firefox baseline at baseCommit.
 */
async function diffOverride(
  name: string,
  projectRoot: string,
  config: FurnaceConfig
): Promise<void> {
  const overrideConfig = config.overrides[name];
  if (!overrideConfig) {
    throw new FurnaceError(`Override "${name}" not found in furnace.json.`, name);
  }
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  const overrideDir = join(furnacePaths.overridesDir, name);
  if (!(await pathExists(overrideDir))) {
    throw new FurnaceError(`Override directory not found: components/overrides/${name}`, name);
  }

  // Prefer the per-override baseCommit (survives download --force). Fall back
  // to the project-wide value for overrides created before this field existed.
  const state = await loadState(projectRoot);
  const baseCommit = overrideConfig.baseCommit ?? state.baseCommit;
  if (!baseCommit) {
    throw new FurnaceError(
      `Cannot diff "${name}": baseCommit not recorded for this override. ` +
        `Run "fireforge furnace refresh --reset-base ${name}" to stamp the current engine HEAD as the baseline, ` +
        `or re-run "fireforge download" to re-establish a project-wide baseline.`,
      name
    );
  }

  const entries = await readdir(overrideDir, { withFileTypes: true });
  let hasDifferences = false;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isComponentSourceFile(entry.name)) continue;

    // git show takes a repo-relative path. paths.engine is the repo root.
    // The slice leaves the host's separators behind, and `git show <ref>:<path>`
    // only understands forward slashes. On Windows the unnormalized form makes
    // every baseline read miss, so every overridden file is reported as a new
    // file and `furnace diff` shows nothing.
    const enginePath = normalizePathSlashes(
      getOverrideEngineTargetPath(paths.engine, overrideConfig, entry.name, ftlDir).slice(
        paths.engine.length + 1
      )
    );
    const modifiedPath = join(overrideDir, entry.name);
    const baselineDisplayPath = enginePath;

    let originalContent: string | null;
    try {
      originalContent = await getFileContentAtRef(paths.engine, enginePath, baseCommit);
    } catch (error: unknown) {
      throw new FurnaceError(
        `Cannot read baseline for "${entry.name}" at commit ${baseCommit.slice(0, 8)}: ` +
          `${toError(error).message}. ` +
          `The commit may no longer exist in the engine history (e.g. after a re-download). ` +
          `Run "fireforge furnace refresh --reset-base ${name}" to establish a new baseline.`,
        name
      );
    }
    if (originalContent === null) {
      info(`${entry.name}: original not found in engine (new file)`);
      hasDifferences = true;
      continue;
    }

    const modifiedContent = await readText(modifiedPath);

    if (originalContent === modifiedContent) {
      continue;
    }

    hasDifferences = true;
    info(`--- ${baselineDisplayPath}`);
    info(`+++ components/overrides/${name}/${entry.name}`);

    for (const line of formatUnifiedDiff(originalContent, modifiedContent)) {
      info(line);
    }

    info('');
  }

  if (!hasDifferences) {
    info('No modifications found');
  }
}

/**
 * Diffs a custom component's workspace files against the engine-deployed
 * copy. Shows what would change (or has changed) on the next
 * `furnace apply`.
 *
 * `.ftl` files deploy to `engine/<ftlDir>/<name>.ftl` via
 * `applyCustomFtlFile`, not to `customConfig.targetPath`, so the
 * deployment-target lookup has to branch on extension. Without the branch, a
 * component's localization file always reports "not yet deployed to engine
 * (new file)" after a successful apply, because diff looks for it under the
 * component's `targetPath` while apply wrote it into the locale tree.
 */
async function diffCustom(name: string, projectRoot: string, config: FurnaceConfig): Promise<void> {
  const customConfig = config.custom[name];
  if (!customConfig) {
    throw new FurnaceError(`Custom component "${name}" not found in furnace.json.`, name);
  }
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  const customDir = join(furnacePaths.customDir, name);
  if (!(await pathExists(customDir))) {
    throw new FurnaceError(`Custom component directory not found: components/custom/${name}`, name);
  }

  const engineDir = join(paths.engine, customConfig.targetPath);

  const entries = await readdir(customDir, { withFileTypes: true });
  let hasDifferences = false;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isComponentSourceFile(entry.name)) continue;

    const workspacePath = join(customDir, entry.name);
    const workspaceContent = await readText(workspacePath);

    // `.ftl` files deploy to the locale tree, not the component's
    // targetPath. Mirror `applyCustomFtlFile`'s target computation so the
    // diff header and the existence probe name the same path apply
    // writes to. Any change here must stay in lock-step with
    // `src/core/furnace-apply-ftl.ts`.
    const isFtl = entry.name.endsWith('.ftl');
    const deployedPath = isFtl
      ? join(paths.engine, ftlDir, entry.name)
      : join(engineDir, entry.name);
    const deployedDisplayPath = isFtl
      ? `engine/${ftlDir}/${entry.name}`
      : `engine/${customConfig.targetPath}/${entry.name}`;

    if (!(await pathExists(deployedPath))) {
      info(`${entry.name}: not yet deployed to engine (new file)`);
      hasDifferences = true;
      continue;
    }

    const deployedContent = await readText(deployedPath);

    if (workspaceContent === deployedContent) {
      continue;
    }

    hasDifferences = true;
    info(`--- ${deployedDisplayPath}`);
    info(`+++ components/custom/${name}/${entry.name}`);

    for (const line of formatUnifiedDiff(deployedContent, workspaceContent)) {
      info(line);
    }

    info('');
  }

  if (!hasDifferences) {
    info('No differences between workspace and engine');
  }
}

/**
 * Runs the furnace diff command.
 *
 * For overrides: shows changes vs the Firefox original at baseCommit.
 * For custom components: shows workspace vs engine-deployed copy.
 * When no name is provided, diffs all override and custom components.
 *
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name to diff (diffs all when omitted)
 */
export async function furnaceDiffCommand(projectRoot: string, name?: string): Promise<void> {
  intro('Furnace Diff');

  const config = await loadFurnaceConfig(projectRoot);

  if (name) {
    if (name in config.overrides) {
      await diffOverride(name, projectRoot, config);
    } else if (name in config.custom) {
      await diffCustom(name, projectRoot, config);
    } else {
      throw new FurnaceError(
        `"${name}" is not found in furnace.json. Run "fireforge furnace list" to see registered components.`,
        name
      );
    }
  } else {
    const overrideNames = Object.keys(config.overrides);
    const customNames = Object.keys(config.custom);

    if (overrideNames.length === 0 && customNames.length === 0) {
      info('No components to diff.');
      outro('Diff complete');
      return;
    }

    for (const overrideName of overrideNames) {
      info(`\n── ${overrideName} (override) ──`);
      await diffOverride(overrideName, projectRoot, config);
    }

    for (const customName of customNames) {
      info(`\n── ${customName} (custom) ──`);
      await diffCustom(customName, projectRoot, config);
    }
  }

  outro('Diff complete');
}
