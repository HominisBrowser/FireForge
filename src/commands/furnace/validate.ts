// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import type { FurnacePaths } from '../../core/furnace-config.js';
import { getFurnacePaths, loadFurnaceConfig } from '../../core/furnace-config.js';
import { assertFurnaceReady } from '../../core/furnace-precondition.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  pruneStaleJarMnEntries,
} from '../../core/furnace-registration.js';
import { validateAllComponents, validateComponent } from '../../core/furnace-validate.js';
import {
  applyValidationExceptions,
  type ValidationExceptionOutcome,
} from '../../core/furnace-validate-exceptions.js';
import { createIssue } from '../../core/furnace-validate-helpers.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceValidateOptions } from '../../types/commands/index.js';
import type { ComponentType, ValidationIssue } from '../../types/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import {
  info,
  intro,
  isMachineOutputMode,
  note,
  outro,
  setMachineOutputMode,
  warn,
} from '../../utils/logger.js';
import { judgeValidateReport, renderValidateHuman, renderValidateJson } from './validate-report.js';

/** Checks that auto-fix can correct. */
const FIXABLE_CHECKS = new Set([
  'missing-jar-mn-mjs',
  'missing-jar-mn-css',
  'wrong-registration-pattern',
  'stale-jar-registration',
  'missing-custom-element-registration',
]);

/**
 * Auto-fixes registration issues that have deterministic solutions.
 * @returns Number of issues fixed
 */
async function autoFixIssues(projectRoot: string, issues: ValidationIssue[]): Promise<number> {
  const { engine: engineDir } = getProjectPaths(projectRoot);
  const config = await loadFurnaceConfig(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);
  let fixed = 0;

  // Group jar.mn fixes per component to batch them
  const jarMnFixesByComponent = new Map<string, string[]>();

  for (const issue of issues) {
    if (!FIXABLE_CHECKS.has(issue.check)) continue;

    const customConfig = config.custom[issue.component];
    if (!customConfig) continue;

    if (issue.check === 'missing-jar-mn-mjs' || issue.check === 'missing-jar-mn-css') {
      const ext = issue.check === 'missing-jar-mn-mjs' ? '.mjs' : '.css';
      const fileName = `${issue.component}${ext}`;
      const existing = jarMnFixesByComponent.get(issue.component) ?? [];
      existing.push(fileName);
      jarMnFixesByComponent.set(issue.component, existing);
    }
  }

  // Prune stale jar.mn registrations (lines pointing at removed or renamed
  // component files). These break packaging, and validate --fix must not
  // report success without touching them.
  if (issues.some((issue) => issue.check === 'stale-jar-registration')) {
    try {
      const pruned = await pruneStaleJarMnEntries(
        engineDir,
        furnacePaths.customDir,
        Object.keys(config.custom)
      );
      fixed += pruned.length;
      for (const entry of pruned) {
        info(`Fixed: pruned stale jar.mn line for ${entry.tagName}/${entry.fileName}`);
      }
    } catch (err: unknown) {
      warn(`Could not prune stale jar.mn lines: ${toError(err).message}`);
    }
  }

  // Fix jar.mn entries
  for (const [componentName, files] of jarMnFixesByComponent) {
    try {
      // addJarMnEntries is idempotent and reports how many entries it
      // actually wrote. Only count + log the files that were added so the
      // reported "fixed" number matches the on-disk change.
      const added = await addJarMnEntries(engineDir, componentName, files);
      fixed += added;
      if (added > 0) {
        info(`Fixed: added ${files.join(', ')} to jar.mn for ${componentName}`);
      } else {
        info(`No-op: jar.mn entries for ${componentName} were already present`);
      }
    } catch (err: unknown) {
      warn(`Could not fix jar.mn for ${componentName}: ${toError(err).message}`);
    }
  }

  // `wrong-registration-pattern` is not auto-fixed: the component is
  // registered but in the wrong block, and moving code between blocks is too
  // risky to do unattended. Only missing registrations are repaired, below.

  // Repair components missing from customElements.js entirely (reported by
  // validate as `missing-custom-element-registration`).
  //
  // Scoped to the components named in `issues`: iterating every entry in
  // `config.custom` makes `furnace validate <one-component> --fix` write
  // customElements.js registrations for every custom component, outside the
  // issue list it was handed and invisibly, since `fixed` is never
  // incremented here.
  const componentsWithIssues = new Set(issues.map((issue) => issue.component));
  for (const componentName of componentsWithIssues) {
    const customConfig = config.custom[componentName];
    if (!customConfig?.register) continue;

    const componentDir = join(furnacePaths.customDir, componentName);
    if (!(await pathExists(componentDir))) continue;

    const entries = await readdir(componentDir, { withFileTypes: true });
    const hasMjs = entries.some((e) => e.isFile() && e.name === `${componentName}.mjs`);
    if (!hasMjs) continue;

    const modulePath = `chrome://global/content/elements/${componentName}.mjs`;
    try {
      // Idempotent: returns without error when already registered, so this
      // stays a no-op for components whose registration is already correct.
      await addCustomElementRegistration(engineDir, componentName, modulePath);
    } catch {
      // Best-effort repair. The re-validation pass at the call site reports
      // whatever is still outstanding.
    }
  }

  return fixed;
}

/** What one validation pass judged, before exceptions are applied. */
interface ValidationRun {
  /** Findings per component, in validation order. */
  results: Map<string, ValidationIssue[]>;
  /** Whether the run judged a component (for stale-exception reporting). */
  judged: (component: string) => boolean;
}

/**
 * Resolves the named component's type and directory.
 * @returns undefined for a stock component (nothing local to validate)
 */
function resolveNamedComponent(
  name: string,
  config: FurnaceConfig,
  furnacePaths: FurnacePaths
): { type: ComponentType; componentDir: string } | undefined {
  if (name in config.overrides) {
    return { type: 'override', componentDir: join(furnacePaths.overridesDir, name) };
  }
  if (name in config.custom) {
    return { type: 'custom', componentDir: join(furnacePaths.customDir, name) };
  }
  if (config.stock.includes(name)) return undefined;
  throw new FurnaceError(`Component "${name}" not found in furnace.json.`, name);
}

/**
 * Runs the first validation pass: one named component, or every override
 * and custom component. Returns undefined when there is nothing local to
 * validate (a stock component, or no components at all), after saying so.
 */
async function runValidationPass(
  projectRoot: string,
  name: string | undefined,
  config: FurnaceConfig,
  furnacePaths: FurnacePaths
): Promise<ValidationRun | undefined> {
  if (name) {
    const target = resolveNamedComponent(name, config, furnacePaths);
    if (target === undefined) {
      info(`"${name}" is a stock component. Stock components are not validated locally.`);
      return undefined;
    }
    if (!(await pathExists(target.componentDir))) {
      throw new FurnaceError(`Component directory not found for "${name}".`, name);
    }
    const issues = await validateComponent(
      target.componentDir,
      name,
      target.type,
      config,
      projectRoot
    );
    return { results: new Map([[name, issues]]), judged: (component) => component === name };
  }

  if (Object.keys(config.overrides).length === 0 && Object.keys(config.custom).length === 0) {
    info('No components to validate.');
    return undefined;
  }
  if (config.stock.length > 0) {
    info(`Skipping ${config.stock.length} stock component(s) (no local files to validate).`);
  }
  return { results: await validateAllComponents(projectRoot), judged: () => true };
}

/**
 * Runs `--fix` over the fixable findings, then re-validates the affected
 * components and swaps their findings in, so the summary and the JSON
 * report what auto-fix actually accomplished. The counter `autoFixIssues`
 * returns only counts calls that did not throw, so a write that succeeded
 * but did not resolve the finding would otherwise still be reported fixed.
 */
async function applyAutoFix(
  projectRoot: string,
  config: FurnaceConfig,
  furnacePaths: FurnacePaths,
  run: ValidationRun,
  countedIssues: readonly ValidationIssue[]
): Promise<void> {
  const fixableIssues = countedIssues.filter((issue) => FIXABLE_CHECKS.has(issue.check));
  if (fixableIssues.length === 0) {
    info('\nNo auto-fixable issues found. Remaining issues require manual resolution.');
    return;
  }
  await autoFixIssues(projectRoot, fixableIssues);

  const reValidated = await reValidateComponents(
    projectRoot,
    config,
    furnacePaths,
    new Set(fixableIssues.map((issue) => issue.component))
  );
  for (const [component, issues] of reValidated) run.results.set(component, issues);

  const fixableAfter = [...reValidated.values()]
    .flat()
    .filter((issue) => FIXABLE_CHECKS.has(issue.check)).length;
  const actuallyFixed = Math.max(0, fixableIssues.length - fixableAfter);
  if (actuallyFixed > 0) {
    info(`\nAuto-fixed ${actuallyFixed} issue(s).`);
  }
  if (fixableAfter > 0) {
    warn(`${fixableAfter} fixable issue(s) remain after auto-fix — investigate manually.`);
  }
}

/** Applies `validationExceptions` to every finding of the run. */
function exceptRun(run: ValidationRun, config: FurnaceConfig): ValidationExceptionOutcome {
  return applyValidationExceptions(
    [...run.results.values()].flat(),
    config.validationExceptions,
    run.judged
  );
}

/**
 * The `furnace.json#minComponents` floor of a full run: an error when it
 * judged fewer components, so a run over an emptied or moved components
 * tree cannot pass by validating nothing. A run naming one component is
 * not judged against it.
 */
function componentFloorIssue(
  config: FurnaceConfig,
  name: string | undefined,
  judged: number
): ValidationIssue | undefined {
  if (name !== undefined || config.minComponents === undefined) return undefined;
  if (judged >= config.minComponents) return undefined;
  return createIssue(
    'furnace.json',
    'error',
    'component-floor',
    `Validated ${judged} component(s), under furnace.json minComponents ${config.minComponents}. ` +
      'Check that the components tree is where furnace.json says, or lower the floor.'
  );
}

/**
 * Runs the furnace validate command to perform static analysis on components.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component name to validate (validates all if omitted)
 * @param options - Optional command options (`--fix`, `--json`, `--max-warnings`)
 */
export async function furnaceValidateCommand(
  projectRoot: string,
  name?: string,
  options: FurnaceValidateOptions = {}
): Promise<void> {
  const previousMachineOutputMode = isMachineOutputMode();
  // `--json` owns stdout: every diagnostic routes to stderr from here on.
  // On a throw the mode stays engaged and withErrorHandling resets it, so
  // the refusal cannot land on stdout after the payload.
  if (options.json === true) setMachineOutputMode(true);
  await runFurnaceValidate(projectRoot, name, options);
  if (isMachineOutputMode() !== previousMachineOutputMode) {
    setMachineOutputMode(previousMachineOutputMode);
  }
}

async function runFurnaceValidate(
  projectRoot: string,
  name: string | undefined,
  options: FurnaceValidateOptions
): Promise<void> {
  intro('Furnace Validate');

  // Gains the engine rung here: this was the one site in the family that
  // checked furnace.json alone, so a validate against a missing engine
  // produced downstream noise instead of the shared precondition refusal.
  const { config } = await assertFurnaceReady(projectRoot);
  const furnacePaths = getFurnacePaths(projectRoot);

  const run = await runValidationPass(projectRoot, name, config, furnacePaths);
  if (run === undefined) {
    const floor = componentFloorIssue(config, name, 0);
    if (options.json === true) {
      renderValidateJson({
        components: [],
        outcome: { issues: floor ? [floor] : [], excepted: [], stale: [] },
        maxWarnings: options.maxWarnings,
      });
    }
    if (floor !== undefined) {
      renderValidateHuman([], [floor]);
      throw new FurnaceError('Validation failed with 1 error(s).');
    }
    outro(name ? 'Validation complete' : 'Done');
    return;
  }

  const floor = componentFloorIssue(config, name, run.results.size);
  const firstPass = exceptRun(run, config);
  if (floor !== undefined) firstPass.issues.push(floor);
  renderValidateHuman([...run.results.keys()], firstPass.issues);

  let outcome = firstPass;
  if (options.fix && firstPass.issues.length > 0) {
    await applyAutoFix(projectRoot, config, furnacePaths, run, firstPass.issues);
    outcome = exceptRun(run, config);
    if (floor !== undefined) outcome.issues.push(floor);
  }

  const report = {
    components: [...run.results.keys()],
    outcome,
    maxWarnings: options.maxWarnings,
  };
  const verdict = judgeValidateReport(report);
  const excepted = outcome.excepted.length > 0 ? `, ${outcome.excepted.length} excepted` : '';
  note(
    `${verdict.errors} error(s), ${verdict.warnings} warning(s)${excepted} across ${report.components.length} component(s)`,
    'Validation Summary'
  );
  if (options.json === true) renderValidateJson(report);

  if (verdict.errors > 0) {
    const fixHint = options.fix ? '' : ' Use --fix to auto-correct registration issues.';
    info(`Fix the errors above and run "fireforge furnace validate" again.${fixHint}`);
    throw new FurnaceError(`Validation failed with ${verdict.errors} error(s).`);
  }
  if (verdict.warningBudgetExceeded) {
    throw new FurnaceError(
      `Validation failed: ${verdict.warnings} warning(s) exceed --max-warnings ${String(options.maxWarnings)}. ` +
        'Fix them, or record a reviewed finding in furnace.json validationExceptions.'
    );
  }

  outro('Validation passed');
}

/**
 * Re-validates a specific set of components after an auto-fix pass and
 * returns each one's post-fix findings. Used by the `--fix` path to
 * honestly report what auto-fix actually accomplished.
 */
async function reValidateComponents(
  projectRoot: string,
  config: FurnaceConfig,
  furnacePaths: FurnacePaths,
  componentNames: Set<string>
): Promise<Map<string, ValidationIssue[]>> {
  const results = new Map<string, ValidationIssue[]>();
  for (const componentName of componentNames) {
    let type: ComponentType;
    let componentDir: string;

    if (componentName in config.overrides) {
      type = 'override';
      componentDir = join(furnacePaths.overridesDir, componentName);
    } else if (componentName in config.custom) {
      type = 'custom';
      componentDir = join(furnacePaths.customDir, componentName);
    } else {
      // Stock or removed components are not local-validated, so skip silently.
      continue;
    }

    if (!(await pathExists(componentDir))) continue;

    results.set(
      componentName,
      await validateComponent(componentDir, componentName, type, config, projectRoot)
    );
  }
  return results;
}
