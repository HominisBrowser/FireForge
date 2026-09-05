// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentType, FurnaceConfig, ValidationIssue } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { getProjectPaths, loadConfig } from './config.js';
import { extractComponentChecksums } from './furnace-checksum-utils.js';
import { getFurnacePaths, loadFurnaceConfig, loadFurnaceState } from './furnace-config.js';
import { resolveFtlDir, xpcshellTestParentDir } from './furnace-constants.js';
import { validateCssFragments } from './furnace-css-fragments.js';
import { detectComposesCycles, validateComposesReferences } from './furnace-graph-utils.js';
import { findJsconfigPathsDrift } from './furnace-jsconfig.js';
import {
  validateAccessibility,
  validateCompatibility,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateStructure,
  validateTokenLink,
} from './furnace-validate-checks.js';
import { createIssue } from './furnace-validate-helpers.js';
import { withRegistrationValidationCache } from './furnace-validate-registration.js';
import {
  findOverrideBaseVersionDrift,
  type OverrideVersionDrift,
} from './furnace-version-drift.js';

function buildOverrideVersionDriftIssues(
  config: FurnaceConfig,
  currentVersion: string,
  tagName?: string
): ValidationIssue[] {
  return findOverrideBaseVersionDrift(config, currentVersion)
    .filter((entry: OverrideVersionDrift) => tagName === undefined || entry.name === tagName)
    .map((entry: OverrideVersionDrift) => ({
      component: entry.name,
      severity: 'error' as const,
      check: 'override-base-version-drift',
      message:
        `Override targets Firefox ${entry.baseVersion}, but fireforge.json records ${entry.currentVersion}. ` +
        'Refresh the override if upstream changed, or update baseVersion in furnace.json to acknowledge the new baseline.',
    }));
}

// ---------------------------------------------------------------------------
// Aggregate validators
// ---------------------------------------------------------------------------

/**
 * Runs all validation checks on a single component.
 *
 * @param componentDir - Path to the component directory
 * @param tagName - Component tag name
 * @param type - Component type (stock, override, custom)
 * @param config - Optional furnace config for cross-component checks
 * @param root - Optional project root for checks that read outside componentDir
 * @param options - Optional behavior flags. `skipAggregateChecks` suppresses the
 *        per-component registration/jar.mn scan so that an outer caller
 *        (e.g. validateAllComponents) can run the aggregate versions once
 *        without double-reporting the same issues.
 * @returns Combined list of validation issues
 */
export async function validateComponent(
  componentDir: string,
  tagName: string,
  type: ComponentType,
  config?: FurnaceConfig,
  root?: string,
  options?: { skipAggregateChecks?: boolean }
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Pass the matching custom config so structure validation can enforce
  // the .ftl-when-localized invariant and accessibility validation can
  // recognize wrapper-over-native components (via `composes` or an
  // explicit `keyboardCovered` opt-out). Non-custom validations ignore the
  // parameter, so this is a no-op for stock and override components.
  const customConfigForTag = type === 'custom' ? config?.custom[tagName] : undefined;
  issues.push(...(await validateStructure(componentDir, tagName, type, customConfigForTag)));
  issues.push(...(await validateAccessibility(componentDir, tagName, customConfigForTag)));
  issues.push(...(await validateCompatibility(componentDir, tagName, type, config, root)));

  if (root && config && type === 'override') {
    const forgeConfig = await loadConfig(root);
    issues.push(...buildOverrideVersionDriftIssues(config, forgeConfig.firefox.version, tagName));
  }

  // Check for missing token link across configured chrome host documents.
  if (root) {
    issues.push(
      ...(await validateTokenLink(
        componentDir,
        tagName,
        root,
        config?.tokenPrefix,
        config?.tokenHostDocuments
      ))
    );
  }

  // CSS fragment checks: missing fragment files are structural errors.
  // Stale deployed expansions are drift the next deploy refreshes.
  if (type === 'custom') {
    const furnacePaths = getFurnacePaths(root ?? join(componentDir, '..', '..', '..'));
    const engineTargetDir =
      root && config?.custom[tagName]
        ? join(getProjectPaths(root).engine, config.custom[tagName].targetPath)
        : undefined;
    issues.push(
      ...(await validateCssFragments(
        componentDir,
        tagName,
        furnacePaths.sharedDir,
        engineTargetDir
      ))
    );
  }

  // Engine-side orphan detection: files a previous deploy placed in the
  // engine whose workspace source has since been renamed or deleted.
  // Surfaces as drift even when every current workspace file is in sync,
  // which is the gap that lets stale jar.mn lines reach a later re-export.
  if (root && config && type === 'custom') {
    const state = await loadFurnaceState(root);
    issues.push(
      ...(await findOrphanedEngineFiles(
        root,
        config,
        tagName,
        state,
        resolveFtlDir(config.ftlBasePath)
      ))
    );
  }

  // When root is provided and this is a custom component with registration,
  // also run registration pattern and jar.mn validation for this component.
  // Skipped when an outer orchestrator (validateAllComponents) will run the
  // aggregate versions itself. Otherwise the same issues are reported twice.
  if (root && config && type === 'custom' && !options?.skipAggregateChecks) {
    const customConfig = config.custom[tagName];
    if (customConfig?.register) {
      const singleConfig: FurnaceConfig = {
        ...config,
        custom: { [tagName]: customConfig },
      };
      issues.push(...(await validateRegistrationPatterns(root, singleConfig)));
      issues.push(...(await validateJarMnEntries(root, singleConfig)));
    }
  }

  return issues;
}

/**
 * Validates all components registered in furnace.json.
 * Stock components are skipped (no local files to validate).
 * @param root - Project root directory
 * @returns Map of component name to its validation issues
 */
export async function validateAllComponents(root: string): Promise<Map<string, ValidationIssue[]>> {
  // Wrapped so the config parse and the chrome-document scan happen once for
  // the whole batch instead of once per component. The caches are inert
  // outside this window, so a direct `validateComponent` caller is never
  // served a stale read.
  return await withRegistrationValidationCache(async () => {
    const config = await loadFurnaceConfig(root);
    const furnacePaths = getFurnacePaths(root);
    const results = new Map<string, ValidationIssue[]>();

    // Validate composition graph integrity (dangling references and cycles)
    try {
      validateComposesReferences(config.stock, config.overrides, config.custom);
    } catch (err: unknown) {
      const message = toError(err).message;
      // Attribute the issue to the first custom component with a bad composes reference
      for (const [name, cfg] of Object.entries(config.custom)) {
        if (cfg.composes) {
          const existing = results.get(name) ?? [];
          existing.push({
            component: name,
            severity: 'error',
            check: 'composes-dangling-reference',
            message,
          });
          results.set(name, existing);
          break;
        }
      }
    }

    try {
      detectComposesCycles(config.custom);
    } catch (err: unknown) {
      const message = toError(err).message;
      // Attribute the cycle issue to the first custom component in the cycle
      for (const name of Object.keys(config.custom)) {
        if (config.custom[name]?.composes) {
          const existing = results.get(name) ?? [];
          existing.push({
            component: name,
            severity: 'error',
            check: 'composes-cycle',
            message,
          });
          results.set(name, existing);
          break;
        }
      }
    }

    // Override components
    for (const name of Object.keys(config.overrides)) {
      const componentDir = join(furnacePaths.overridesDir, name);
      if (!(await pathExists(componentDir))) {
        results.set(name, [
          {
            component: name,
            severity: 'error',
            check: 'missing-component-dir',
            message: `Component directory not found: components/overrides/${name}`,
          },
        ]);
        continue;
      }
      const issues = await validateComponent(componentDir, name, 'override', config, root);
      results.set(name, issues);
    }

    // Custom components
    for (const name of Object.keys(config.custom)) {
      const componentDir = join(furnacePaths.customDir, name);
      if (!(await pathExists(componentDir))) {
        results.set(name, [
          {
            component: name,
            severity: 'error',
            check: 'missing-component-dir',
            message: `Component directory not found: components/custom/${name}`,
          },
        ]);
        continue;
      }
      // Pass root so that per-component token link validation runs.
      // Skip registration/jar.mn checks inside validateComponent. The aggregate
      // validators below run them exactly once across all components, which both
      // surfaces cross-component issues and avoids double-counting.
      const issues = await validateComponent(componentDir, name, 'custom', config, root, {
        skipAggregateChecks: true,
      });
      results.set(name, issues);
    }

    // Registration pattern validation (customElements.js Pattern A vs B)
    const registrationIssues = await validateRegistrationPatterns(root, config);
    for (const issue of registrationIssues) {
      const existing = results.get(issue.component) ?? [];
      existing.push(issue);
      results.set(issue.component, existing);
    }

    // jar.mn entry validation
    const jarMnIssues = await validateJarMnEntries(root, config);
    for (const issue of jarMnIssues) {
      const existing = results.get(issue.component) ?? [];
      existing.push(issue);
      results.set(issue.component, existing);
    }

    // Orphan xpcshell scaffold detection.
    // `furnace create --with-tests --xpcshell` scaffolds a test directory at
    // `browser/base/content/test/<binary>-xpcshell/<name>/`. A leftover
    // scaffold whose `<name>` is not in furnace.json is almost always the
    // aftermath of an incomplete `furnace remove` or `rename`. Flag it as an
    // `orphan-xpcshell-scaffold` error so operators delete or re-create the
    // scaffold instead of discovering the mismatch at test run time. A
    // missing engine or scaffold parent directory degrades silently, so this
    // check never adds noise on a project that never used xpcshell
    // scaffolding.
    try {
      const orphanIssues = await findOrphanXpcshellScaffolds(root, config);
      for (const issue of orphanIssues) {
        const existing = results.get(issue.component) ?? [];
        existing.push(issue);
        results.set(issue.component, existing);
      }
    } catch {
      // Validation degrades gracefully: the absence of an engine
      // directory, permission denial reading the scaffold tree, or any
      // other transient fs issue should never cascade into false
      // "orphan" reports.
    }

    // jsconfig chrome-module paths drift: when `typecheckJsconfig` is
    // configured, deploy maintains a paths mapping per deployed module file.
    // Missing or stale entries mean typed cross-module imports are silently
    // degrading to `any` in the consumer's typecheck.
    if (config.typecheckJsconfig) {
      try {
        const drift = await findJsconfigPathsDrift(root, config);
        if (drift.changed) {
          const detail = [
            ...drift.added.map((key) => `missing: ${key}`),
            ...drift.updated.map((key) => `stale: ${key}`),
            ...drift.pruned.map((key) => `orphaned: ${key}`),
          ].join('; ');
          const issue: ValidationIssue = {
            component: 'furnace',
            severity: 'warning',
            check: 'jsconfig-paths-drift',
            message:
              `${config.typecheckJsconfig} chrome-module paths are out of sync with the workspace (${detail}). ` +
              'Run "fireforge furnace deploy" to update them.',
          };
          const existing = results.get(issue.component) ?? [];
          existing.push(issue);
          results.set(issue.component, existing);
        }
      } catch {
        // Drift detection must not break validation when the jsconfig is
        // missing or unparsable. Deploy reports those cases with guidance.
      }
    }

    return results;
  });
}

/**
 * Scans the per-binary xpcshell scaffold directory for entries whose
 * component name is not present in furnace.json, and returns an
 * `orphan-xpcshell-scaffold` issue for each one.
 */
async function findOrphanXpcshellScaffolds(
  root: string,
  config: FurnaceConfig
): Promise<ValidationIssue[]> {
  const forgeConfig = await loadConfig(root);
  const paths = getProjectPaths(root);
  const parentRel = xpcshellTestParentDir(forgeConfig.binaryName);
  const parentAbs = join(paths.engine, parentRel);
  if (!(await pathExists(parentAbs))) return [];

  let entries: string[];
  try {
    const dirents = await readdir(parentAbs, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // An unreadable parent directory yields no sibling component dirs.
    return [];
  }

  const known = new Set<string>([
    ...Object.keys(config.custom),
    ...Object.keys(config.overrides),
    ...config.stock,
  ]);

  const issues: ValidationIssue[] = [];
  for (const entry of entries) {
    if (known.has(entry)) continue;
    const chromeDocPackagingTest = join(parentAbs, entry, `test_${entry}_packaging.js`);
    if (await pathExists(chromeDocPackagingTest)) continue;
    issues.push({
      component: entry,
      severity: 'error',
      check: 'orphan-xpcshell-scaffold',
      message:
        `Stale xpcshell test scaffold at ${parentRel}/${entry}/ — no matching component is declared in furnace.json. ` +
        'Delete the scaffold directory manually, or re-run `fireforge furnace create --with-tests --xpcshell` for an existing component with the same name.',
    });
  }
  return issues;
}

/**
 * Flags engine-side files that a previous deploy of `tagName` left behind
 * after their workspace source was renamed or removed.
 *
 * Detection keys on the furnace state file: every `appliedChecksums` entry
 * under `custom/<tagName>/` whose workspace source no longer exists but whose
 * engine target is still present is an orphan. The next deploy prunes it, but
 * until then jar.mn and the deployed directory disagree with the workspace,
 * and a re-export could capture the stale state into a patch.
 *
 * Custom components only: override undeploys restore the upstream baseline
 * rather than deleting files, so "orphan" has no meaning there.
 */
export async function findOrphanedEngineFiles(
  root: string,
  config: FurnaceConfig,
  tagName: string,
  state: { appliedChecksums?: Record<string, string> },
  ftlDir: string
): Promise<ValidationIssue[]> {
  const customConfig = config.custom[tagName];
  if (!customConfig) return [];

  const previous = extractComponentChecksums(state.appliedChecksums, 'custom', tagName);
  const fileNames = Object.keys(previous);
  if (fileNames.length === 0) return [];

  const { engine: engineDir, componentsDir } = getProjectPaths(root);
  const componentDir = join(componentsDir, 'custom', tagName);

  const issues: ValidationIssue[] = [];
  for (const fileName of fileNames) {
    if (await pathExists(join(componentDir, fileName))) continue;
    const enginePath = fileName.endsWith('.ftl')
      ? join(engineDir, ftlDir, fileName)
      : join(engineDir, customConfig.targetPath, fileName);
    if (!(await pathExists(enginePath))) continue;
    issues.push(
      createIssue(
        tagName,
        'warning',
        'orphaned-engine-file',
        `Engine file ${fileName} was deployed by a previous apply but its workspace source ` +
          `is gone (renamed or deleted). The deployed copy${customConfig.register ? ' and any stale jar.mn entry' : ''} ` +
          `will linger until the next deploy prunes it. Run "fireforge furnace deploy ${tagName}".`
      )
    );
  }
  return issues;
}
