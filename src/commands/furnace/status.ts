// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  extractComponentChecksums,
  hasComponentChanged,
  hasCustomEngineDrift,
  hasOverrideEngineDrift,
} from '../../core/furnace-apply.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from '../../core/furnace-config.js';
import { resolveFtlDir } from '../../core/furnace-constants.js';
import { checkRegistrationConsistency } from '../../core/furnace-validate-checks.js';
import {
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftWarning,
} from '../../core/furnace-version-drift.js';
import { FurnaceError } from '../../errors/furnace.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, note, outro, warn } from '../../utils/logger.js';

/**
 * Displays detailed status for a single Furnace component, including registration drift.
 * @param name - Component tag name to inspect
 * @param config - Loaded Furnace configuration
 * @param projectRoot - Root directory of the project
 */
async function showDetailedComponentStatus(
  name: string,
  config: Awaited<ReturnType<typeof loadFurnaceConfig>>,
  state: Awaited<ReturnType<typeof loadFurnaceState>>,
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  furnacePaths: ReturnType<typeof getFurnacePaths>,
  ftlDir: string
): Promise<void> {
  const customConfig = config.custom[name];
  const overrideConfig = config.overrides[name];

  if (!customConfig && !overrideConfig && !config.stock.includes(name)) {
    throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
  }

  if (overrideConfig) {
    info(`"${name}" is an override component (${overrideConfig.type}).`);
    info(`Base path: ${overrideConfig.basePath}`);
    info(`Base version: ${overrideConfig.baseVersion}`);

    // baseVersion drift is advisory but reported here alongside the other
    // override metadata so the operator sees the warning before drilling
    // into registration drift or file diff.
    const forgeConfig = await loadConfig(projectRoot);
    const scopedDrift = findOverrideBaseVersionDrift(config, forgeConfig.firefox.version).filter(
      (entry) => entry.name === name
    );
    for (const entry of scopedDrift) {
      warn(formatOverrideBaseVersionDriftWarning(entry));
    }

    const overrideDir = join(furnacePaths.overridesDir, name);
    const sourceExists = await pathExists(overrideDir);
    const lines = [`${sourceExists ? '\u2713' : '\u2717'} Override directory exists`];

    if (!sourceExists) {
      lines.push('\u2717 Workspace status unavailable (override directory missing)');
      lines.push('\u2717 Engine comparison unavailable (override directory missing)');
      note(lines.join('\n'), `${name} Override Status`);
      outro('Status complete');
      return;
    }

    const previous = extractComponentChecksums(state.appliedChecksums, 'override', name);
    const workspaceChanged = await hasComponentChanged(overrideDir, previous);
    lines.push(`${workspaceChanged ? '\u2717' : '\u2713'} Workspace unchanged since last apply`);

    const engineExists = await pathExists(paths.engine);
    if (!engineExists) {
      lines.push('\u2717 Engine comparison unavailable (engine directory missing)');
      note(lines.join('\n'), `${name} Override Status`);
      outro('Status complete');
      return;
    }

    const engineDrifted = await hasOverrideEngineDrift(
      paths.engine,
      overrideDir,
      overrideConfig,
      ftlDir
    );
    lines.push(`${engineDrifted ? '\u2717' : '\u2713'} Engine matches override workspace`);

    note(lines.join('\n'), `${name} Override Status`);

    outro('Status complete');
    return;
  }

  if (config.stock.includes(name)) {
    info(`"${name}" is a stock component. No local registration to check.`);
    outro('Status complete');
    return;
  }

  if (!customConfig) {
    outro('Status complete');
    return;
  }

  // Custom component — run registration consistency check
  const status = await checkRegistrationConsistency(projectRoot, name, customConfig, ftlDir);

  const lines: string[] = [];
  const check = (ok: boolean, label: string): void => {
    lines.push(`${ok ? '\u2713' : '\u2717'} ${label}`);
  };

  check(status.sourceExists, 'Source directory exists');
  check(status.targetExists, 'Target directory exists in engine');
  check(status.filesInSync, 'Source and target files in sync');
  check(status.jarMnMjs, `jar.mn has ${name}.mjs entry`);
  check(status.jarMnCss, `jar.mn has ${name}.css entry`);
  check(status.customElementsPresent, 'Registered in customElements.js');
  check(status.customElementsCorrectBlock, 'In correct DOMContentLoaded block');

  if (status.driftedFiles.length > 0) {
    lines.push(`Drifted files: ${status.driftedFiles.join(', ')}`);
  }
  if (status.missingTargetFiles.length > 0) {
    lines.push(`Missing in engine: ${status.missingTargetFiles.join(', ')}`);
  }

  note(lines.join('\n'), `${name} Registration Status`);

  outro('Status complete');
}

/**
 * Runs the furnace status command to show an overview of Furnace state.
 * When a component name is provided, shows detailed registration status.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name for detailed status
 */
export async function furnaceStatusCommand(projectRoot: string, name?: string): Promise<void> {
  intro('Furnace');

  if (!(await furnaceConfigExists(projectRoot))) {
    info(
      'Furnace is not configured. Run `fireforge furnace create` or `fireforge furnace override` to get started.'
    );
    outro('');
    return;
  }

  const config = await loadFurnaceConfig(projectRoot);
  const state = await loadFurnaceState(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  const ftlDir = resolveFtlDir(config.ftlBasePath);

  if (name) {
    await showDetailedComponentStatus(
      name,
      config,
      state,
      projectRoot,
      paths,
      furnacePaths,
      ftlDir
    );
    return;
  }

  // Surface a pendingRepair marker before the normal summary so it cannot
  // be missed. The marker means the last mutation could not roll back
  // cleanly, so the engine and workspace may have drifted in ways apply
  // cannot detect from checksums alone — doctor is the right next step.
  if (state.pendingRepair) {
    warn(
      `Furnace is in pending-repair state from ${state.pendingRepair.operation} (${state.pendingRepair.timestamp}): ${state.pendingRepair.reason}. Run \`fireforge doctor --repair-furnace\` to reconcile.`
    );
  }

  // --- Overview mode ---
  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;
  const stockCount = config.stock.length;

  // Build summary lines
  const lines: string[] = [];
  lines.push(`Component prefix: ${config.componentPrefix || '(none)'}`);
  lines.push(`Stock components: ${stockCount}`);

  // Overrides
  lines.push(`Override components: ${overrideCount}`);
  if (overrideCount > 0) {
    for (const [oName, entry] of Object.entries(config.overrides)) {
      lines.push(`  ${oName} (${entry.type})`);
    }
  }

  // Custom
  lines.push(`Custom components: ${customCount}`);
  if (customCount > 0) {
    for (const cName of Object.keys(config.custom)) {
      lines.push(`  ${cName}`);
    }
  }

  // Last apply
  lines.push(`Last apply: ${state.lastApply ?? 'never'}`);

  note(lines.join('\n'), 'Furnace Status');

  // Surface override baseVersion drift from the project config. This check
  // is cheap (no I/O besides the already-loaded fireforge.json) and catches
  // the single most common silent-drift case: Firefox bumped, overrides
  // still point at the old version. Advisory only — status never fails.
  const forgeConfig = await loadConfig(projectRoot);
  for (const entry of findOverrideBaseVersionDrift(config, forgeConfig.firefox.version)) {
    warn(formatOverrideBaseVersionDriftWarning(entry));
  }

  // Check for both workspace changes (developer edits) and engine drift
  // (reset/download/manual edits). The two have different remediation
  // hints, so report them separately rather than collapsing into a single
  // "something is off" message.
  if (await pathExists(paths.engine)) {
    let workspaceChanged = false;
    let engineDrifted = false;

    for (const [oName, overrideConfig] of Object.entries(config.overrides)) {
      const componentDir = join(furnacePaths.overridesDir, oName);
      if (!(await pathExists(componentDir))) continue;
      const previous = extractComponentChecksums(state.appliedChecksums, 'override', oName);
      if (await hasComponentChanged(componentDir, previous)) {
        workspaceChanged = true;
      } else if (await hasOverrideEngineDrift(paths.engine, componentDir, overrideConfig, ftlDir)) {
        engineDrifted = true;
      }
      if (workspaceChanged && engineDrifted) break;
    }

    if (!(workspaceChanged && engineDrifted)) {
      for (const [cName, customConfig] of Object.entries(config.custom)) {
        const componentDir = join(furnacePaths.customDir, cName);
        if (!(await pathExists(componentDir))) continue;
        const previous = extractComponentChecksums(state.appliedChecksums, 'custom', cName);
        if (await hasComponentChanged(componentDir, previous)) {
          workspaceChanged = true;
        } else if (
          await hasCustomEngineDrift(projectRoot, cName, componentDir, customConfig, ftlDir)
        ) {
          engineDrifted = true;
        }
        if (workspaceChanged && engineDrifted) break;
      }
    }

    if (workspaceChanged) {
      warn(
        'Components have been modified since last apply. Run `fireforge build` or `fireforge furnace apply`.'
      );
    }
    if (engineDrifted) {
      warn(
        'Engine drift detected since last apply (reset/download/manual edit). Run `fireforge furnace apply` to re-deploy.'
      );
    }
  }

  info(
    'Tip: run `furnace status <name>` for detailed component info, or `furnace --help` for all subcommands.'
  );

  outro('Status complete');
}
