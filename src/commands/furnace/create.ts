// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { text } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { stdioIsInteractive } from '../../core/destructive.js';
import { getFurnacePaths, writeFurnaceConfig } from '../../core/furnace-config.js';
import {
  resolveFtlChromeSubPath,
  tagNameToClassName,
  WIDGETS_DIR,
} from '../../core/furnace-constants.js';
import {
  completeJournalRollback,
  type FurnaceOperationContext,
  runFurnaceMutation,
} from '../../core/furnace-operation.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  CUSTOM_ELEMENT_TAG_RULES,
  describeTagNameProblem,
} from '../../core/furnace-registration-validate.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { isComponentInEngine, scanWidgetsDirectory } from '../../core/furnace-scanner.js';
import { DEFAULT_LICENSE, getLicenseHeader } from '../../core/license-headers.js';
import { validateSharedFtl } from '../../core/shared-ftl.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceCreateOptions } from '../../types/commands/index.js';
import type { ProjectLicense } from '../../types/config.js';
import type { FurnaceConfig, ResolvedTestStyle } from '../../types/furnace.js';
import { ensureDir, pathExists, writeText } from '../../utils/fs.js';
import { cancel, intro, isCancel, note, outro } from '../../utils/logger.js';
import { loadAuthoringFurnaceConfig } from './authoring-config.js';
import { resolveValidatedTestDir, scaffoldTestFiles } from './create-browser-test.js';
import { formatDryRunPlan, formatSuccessNote } from './create-dry-run.js';
import { resolveCreateFeatures } from './create-features.js';
import { scaffoldMochikitTestFiles } from './create-mochikit.js';
import { assertCustomEntryPersisted } from './create-readback.js';
import { generateCssContent, generateFtlContent, generateMjsContent } from './create-templates.js';
import { validateCreateAgainstConfig } from './create-validation.js';
import { scaffoldXpcshellTestFiles } from './create-xpcshell.js';

function knownComponentSet(config: FurnaceConfig): Set<string> {
  return new Set([
    ...config.stock,
    ...Object.keys(config.overrides),
    ...Object.keys(config.custom),
  ]);
}

async function resolveComposeStockAdditions(args: {
  engineDir: string;
  config: FurnaceConfig;
  componentName: string;
  composes: string[] | undefined;
}): Promise<string[]> {
  const { engineDir, config, componentName, composes } = args;
  if (!composes || composes.length === 0) return [];

  const known = knownComponentSet(config);
  const unresolved = composes.filter((tag) => tag !== componentName && !known.has(tag));
  if (unresolved.length === 0 || !(await pathExists(engineDir))) return [];

  const scanPaths = config.scanPaths && config.scanPaths.length > 0 ? config.scanPaths : undefined;
  const discovered = await scanWidgetsDirectory(engineDir, undefined, scanPaths);
  const discoveredTags = new Set(discovered.map((component) => component.tagName));

  return unresolved.filter(
    (tag, index) => discoveredTags.has(tag) && unresolved.indexOf(tag) === index
  );
}

/**
 * Validates a custom element tag name.
 * @returns Error message if invalid, undefined if valid
 */
function validateTagName(name: string): string | undefined {
  if (!name.trim()) return 'Name is required';
  if (!name.includes('-')) return 'Custom element names must contain a hyphen (e.g., "my-widget")';
  if (!CUSTOM_ELEMENT_TAG_PATTERN.test(name)) return `Name ${CUSTOM_ELEMENT_TAG_RULES}`;
  return undefined;
}

interface WriteComponentFilesOptions {
  /** Destination component directory. */
  componentDir: string;
  /** Custom element tag name. */
  componentName: string;
  /** Generated component class name. */
  className: string;
  /** Human-readable component description. */
  description: string;
  /** Whether to include a Fluent file. */
  localized: boolean;
  /** Project license used for generated headers. */
  license: ProjectLicense;
  /** chrome:// sub-path for the generated FTL reference, when localized. */
  ftlChromeSubPath: string | undefined;
  /** Explicit shared FTL path from `--shared-ftl`, when supplied. */
  sharedFtl: string | undefined;
  /** Optional rollback journal that snapshots files before writes. */
  journal?: RollbackJournal | undefined;
}

/**
 * Writes the scaffolded component source files to disk.
 * @param options - See {@link WriteComponentFilesOptions}
 * @returns Relative filenames written for the component
 */
async function writeComponentFiles(options: WriteComponentFilesOptions): Promise<string[]> {
  const {
    componentDir,
    componentName,
    className,
    description,
    localized,
    license,
    ftlChromeSubPath,
    sharedFtl,
    journal,
  } = options;
  await ensureDir(componentDir);

  const files = [`${componentName}.mjs`, `${componentName}.css`];

  const mjsPath = join(componentDir, `${componentName}.mjs`);
  if (journal) await snapshotFile(journal, mjsPath);
  const mjsContent = generateMjsContent({
    name: componentName,
    className,
    description,
    localized,
    header: getLicenseHeader(license, 'js'),
    ftlChromeSubPath,
    sharedFtl,
  });
  await writeText(mjsPath, mjsContent);

  const cssPath = join(componentDir, `${componentName}.css`);
  if (journal) await snapshotFile(journal, cssPath);
  const cssContent = generateCssContent(getLicenseHeader(license, 'css'));
  await writeText(cssPath, cssContent);

  // Skip the per-component .ftl stub when the component participates in a
  // pre-existing feature-scoped bundle. The shared bundle is owned
  // elsewhere; dropping a stub here would clutter the workspace with
  // empty files that never get packaged (furnace apply also skips copying
  // them in this mode).
  if (localized && !sharedFtl) {
    const ftlPath = join(componentDir, `${componentName}.ftl`);
    if (journal) await snapshotFile(journal, ftlPath);
    const ftlContent = generateFtlContent(componentName, getLicenseHeader(license, 'hash'));
    await writeText(ftlPath, ftlContent);
    files.push(`${componentName}.ftl`);
  }

  return files;
}

/**
 * Collapses `--with-tests`, `--xpcshell`, and `--test-style` into the single
 * scaffold dispatch used inside the mutation phase.
 *
 * Invariants:
 * - `--xpcshell` alone is equivalent to `--test-style=xpcshell`.
 * - `--with-tests` alone (no `--test-style`) defaults to `browser-chrome`
 *   (multi-process mochitest; reliable on macOS for interactive chrome).
 *   Forks whose chrome document has no `tabbrowser` should pass
 *   `--test-style=mochikit` explicitly.
 * - When both `--xpcshell` and `--with-tests` are set, `--xpcshell` wins
 *   (resolved style is `xpcshell` only).
 * @throws InvalidArgumentError when flags conflict.
 */
export function resolveTestStyle(options: FurnaceCreateOptions): ResolvedTestStyle {
  const xpcshellFlag = options.xpcshell ?? false;
  const withTests = options.withTests ?? false;
  const explicit = options.testStyle;

  if (xpcshellFlag && explicit && explicit !== 'xpcshell') {
    throw new InvalidArgumentError(
      `--xpcshell cannot be combined with --test-style=${explicit}; choose one.`,
      'testStyle'
    );
  }

  if (explicit) return explicit;
  if (xpcshellFlag) return 'xpcshell';
  if (withTests) return 'browser-chrome';
  return 'none';
}

/**
 * Performs the transactional mutation phase of furnace create. All file
 * writes and the config update are recorded in a rollback journal so a
 * failure mid-phase restores the workspace and engine to their pre-command
 * state.
 */
async function performCreateMutations(args: {
  projectRoot: string;
  componentName: string;
  className: string;
  description: string;
  localized: boolean;
  register: boolean;
  composes: string[] | undefined;
  sharedFtl: string | undefined;
  componentDir: string;
  furnacePaths: { furnaceConfig: string };
  allowPrefixMismatch: boolean | undefined;
  forgeConfig: { binaryName: string };
  paths: { engine: string };
  license: ProjectLicense;
  testStyle: ResolvedTestStyle;
  testDir: string | undefined;
  operationContext?: FurnaceOperationContext;
}): Promise<{ files: string[]; testFiles: string[] }> {
  // Invariant: the journal MUST be registered with the operation context
  // BEFORE any filesystem mutation (including recordCreatedDir, whose entries
  // are consulted by SIGINT rollback). The try/catch below assumes signal
  // handlers can find the journal for any partial write that follows.
  const journal = createRollbackJournal();
  if (args.operationContext) {
    args.operationContext.registerJournal(journal);
  }

  const testFiles: string[] = [];
  let files: string[];

  try {
    const freshConfig = await loadAuthoringFurnaceConfig(args.projectRoot);
    const freshStockAdditions = await resolveComposeStockAdditions({
      engineDir: args.paths.engine,
      config: freshConfig,
      componentName: args.componentName,
      composes: args.composes,
    });
    validateCreateAgainstConfig(
      freshConfig,
      args.componentName,
      args.allowPrefixMismatch,
      args.composes,
      freshStockAdditions
    );
    if (await pathExists(args.componentDir)) {
      throw new FurnaceError(
        `Directory already exists: components/custom/${args.componentName}`,
        args.componentName
      );
    }

    // Record the componentDir creation entry immediately after registration
    // so signal-driven rollback can clean it up even if writeComponentFiles
    // is interrupted mid-ensureDir.
    recordCreatedDir(journal, args.componentDir);
    files = await writeComponentFiles({
      componentDir: args.componentDir,
      componentName: args.componentName,
      className: args.className,
      description: args.description,
      localized: args.localized,
      license: args.license,
      ftlChromeSubPath: resolveFtlChromeSubPath(freshConfig.ftlBasePath),
      sharedFtl: args.sharedFtl,
      journal,
    });

    const customEntry: import('../../types/furnace.js').CustomComponentConfig = {
      description: args.description,
      targetPath: `${WIDGETS_DIR}/${args.componentName}`,
      register: args.register,
      localized: args.localized,
    };
    if (args.composes && args.composes.length > 0) {
      customEntry.composes = args.composes;
    }
    if (args.sharedFtl) {
      customEntry.sharedFtl = args.sharedFtl;
    }
    for (const name of freshStockAdditions) {
      if (!freshConfig.stock.includes(name)) {
        freshConfig.stock.push(name);
      }
    }
    freshConfig.custom[args.componentName] = customEntry;

    await snapshotFile(journal, args.furnacePaths.furnaceConfig);
    await writeFurnaceConfig(args.projectRoot, freshConfig);
    await assertCustomEntryPersisted(args.projectRoot, args.componentName);

    if (args.testStyle === 'browser-chrome') {
      const scafFiles = await scaffoldTestFiles(
        args.componentName,
        args.license,
        args.forgeConfig,
        args.paths,
        journal,
        args.testDir
      );
      testFiles.push(...scafFiles);
    } else if (args.testStyle === 'xpcshell') {
      const xpcshellFiles = await scaffoldXpcshellTestFiles(
        args.componentName,
        args.license,
        args.forgeConfig,
        args.paths,
        journal,
        args.testDir
      );
      testFiles.push(...xpcshellFiles);
    } else if (args.testStyle === 'mochikit') {
      const mochikitFiles = await scaffoldMochikitTestFiles(
        args.componentName,
        args.license,
        args.paths,
        journal
      );
      testFiles.push(...mochikitFiles);
    }
  } catch (error: unknown) {
    // `operationContext` is optional here (the dry-run and no-journal paths
    // pass none), so the shared handler only applies when there is a
    // lifecycle wrapper to tell.
    if (args.operationContext) {
      return await completeJournalRollback(args.operationContext, journal, error, {
        projectRoot: args.projectRoot,
        operation: 'create-rollback',
        failureMessage: `Failed to create custom component "${args.componentName}"`,
        subject: `component "${args.componentName}"`,
      });
    }
    throw error;
  }

  return { files, testFiles };
}

/**
 * Prompts the operator for a description when the command is interactive and
 * the operator did not pass `-d`. Returns the resolved description string.
 */
async function resolveDescription(
  isInteractive: boolean,
  options: FurnaceCreateOptions
): Promise<string> {
  let description = options.description ?? '';
  if (!description && isInteractive) {
    const descResult = await text({
      message: 'Description (optional):',
      placeholder: 'A brief description of the component',
    });

    if (!isCancel(descResult)) {
      description = descResult;
    }
  }
  return description;
}

/**
 * Runs the furnace create command to scaffold a new custom component.
 * @param projectRoot - Root directory of the project
 * @param name - Optional component tag name (prompted if not provided)
 * @param options - CLI options for non-interactive mode
 */
export async function furnaceCreateCommand(
  projectRoot: string,
  name?: string,
  options: FurnaceCreateOptions = {}
): Promise<void> {
  const isInteractive = stdioIsInteractive();
  const isDryRun = options.dryRun ?? false;

  intro(isDryRun ? 'Furnace Create (dry run)' : 'Furnace Create');

  // --- Resolve component name ---
  // Validation runs before we load/create any persisted furnace config so a
  // failed authoring command never auto-creates furnace.json in a fresh
  // directory.
  let componentName = name;

  if (componentName) {
    const validationError = validateTagName(componentName);
    if (validationError) {
      throw new InvalidArgumentError(validationError, 'name');
    }
  } else if (!isInteractive) {
    throw new InvalidArgumentError(
      'Component name is required in non-interactive mode.\n' +
        'Usage: fireforge furnace create <name> -d "description"',
      'name'
    );
  }

  const paths = getProjectPaths(projectRoot);
  const forgeConfig = await loadConfig(projectRoot);
  const license = forgeConfig.license ?? DEFAULT_LICENSE;
  const furnacePaths = getFurnacePaths(projectRoot);

  if (!componentName) {
    // Interactive prompt path; non-interactive missing-name was rejected above.
    const nameResult = await text({
      message: 'Component tag name:',
      placeholder: 'moz-my-widget',
      // Message-returning form: the throwing `validateTagName` escaped
      // clack's validation loop and killed the prompt on a bad name.
      validate: (value) => describeTagNameProblem(value ?? ''),
    });

    if (isCancel(nameResult)) {
      cancel('Create cancelled');
      return;
    }

    componentName = nameResult;
  }

  // Load the current furnace config only after the interactive name prompt
  // succeeds so a cancelled create in a fresh project does not strand a new
  // furnace.json behind.
  const config = await loadAuthoringFurnaceConfig(projectRoot);

  const composes = options.compose;
  const stockAdditions = await resolveComposeStockAdditions({
    engineDir: paths.engine,
    config,
    componentName,
    composes,
  });
  validateCreateAgainstConfig(
    config,
    componentName,
    options.allowPrefixMismatch,
    composes,
    stockAdditions
  );

  // Check if it already exists in the engine source tree
  if (await pathExists(paths.engine)) {
    if (await isComponentInEngine(paths.engine, componentName)) {
      throw new FurnaceError(
        `"${componentName}" already exists in the engine source tree. Use "fireforge furnace override" instead.`,
        componentName
      );
    }
  }

  // --- Resolve description ---
  const description = await resolveDescription(isInteractive, options);

  // --- Resolve features ---
  const featureSelection = await resolveCreateFeatures(isInteractive, options);
  if (!featureSelection) {
    return;
  }
  const { localized, register } = featureSelection;

  // Collapse --with-tests / --xpcshell / --test-style into the single
  // scaffold selection used by the mutation phase. The resolver validates
  // incompatible combinations up-front so a bad flag set never strands a
  // partial mutation behind.
  const testStyle = resolveTestStyle(options);
  const testDir = resolveValidatedTestDir(options.testDir, testStyle);
  // Not routed through assertFurnaceEngineReady: this rung is CONDITIONAL on
  // a test style being requested, and it names the component so the refusal
  // identifies which create failed. Both are outside the shared helper's
  // shape, and a scaffold without --with-tests must keep working with no
  // engine present.
  if (testStyle !== 'none' && !(await pathExists(paths.engine))) {
    throw new FurnaceError(
      'Engine directory not found. Run "fireforge download" first to use --with-tests, --xpcshell, or --test-style.',
      componentName
    );
  }

  // --- Generate component files ---
  const className = tagNameToClassName(componentName);
  const componentDir = join(furnacePaths.customDir, componentName);

  // Check if directory already exists on disk
  if (await pathExists(componentDir)) {
    throw new FurnaceError(
      `Directory already exists: components/custom/${componentName}`,
      componentName
    );
  }

  // Normalize and validate --shared-ftl ahead of any writes. Shares the
  // structural rules with furnace-config.ts so the command and the on-disk
  // schema cannot diverge. Pass the resolved `localized` rather than a `true`
  // literal so the validator's cross-field check stays anchored to the real
  // feature selection — `resolveCreateFeatures` promotes localized upstream,
  // and hard-coding `true` here would hide a regression if that promotion
  // ever moved or dropped.
  let sharedFtl: string | undefined;
  if (options.sharedFtl !== undefined) {
    const result = validateSharedFtl(options.sharedFtl, { localized });
    if (!result.ok) {
      throw new InvalidArgumentError(`--shared-ftl ${result.reason}.`, 'sharedFtl');
    }
    sharedFtl = result.value;
  }

  // Dry-run exits here — every validation that does not need a write has
  // already run, so the plan we render reflects exactly what the real
  // command would do. The mutation phase and its rollback journal are
  // intentionally skipped so no furnace.json/engine state is touched.
  if (isDryRun) {
    const plan = formatDryRunPlan({
      componentName,
      localized,
      register,
      composes,
      stockAdditions,
      // Spread rather than assign so the key is absent when sharedFtl is
      // undefined — the DryRunPlanInput type uses strict-optional shape.
      ...(sharedFtl !== undefined ? { sharedFtl } : {}),
      testStyle,
      description,
      binaryName: forgeConfig.binaryName,
      // The plan must name the directory the scaffolder will actually use:
      // an omitted override here is how the printed path came to disagree
      // with the files a real run wrote.
      ...(testDir !== undefined ? { testDir } : {}),
    });
    note(plan, componentName);
    outro('Dry run complete (no files modified)');
    return;
  }

  // All validation is done. Hand off to the transactional mutation helper
  // so any failure restores the workspace and engine to their pre-command
  // state via the shared rollback journal. The mutation runs under the
  // furnace-wide lock and is registered with the global SIGINT/SIGTERM
  // rollback pathway.
  const { files, testFiles } = await runFurnaceMutation(projectRoot, 'create-rollback', (ctx) =>
    performCreateMutations({
      projectRoot,
      componentName,
      className,
      description,
      localized,
      register,
      composes,
      sharedFtl,
      componentDir,
      furnacePaths,
      allowPrefixMismatch: options.allowPrefixMismatch,
      forgeConfig,
      paths,
      license,
      testStyle,
      testDir,
      operationContext: ctx,
    })
  );

  note(
    formatSuccessNote({
      componentName,
      files,
      testFiles,
      testStyle,
      binaryName: forgeConfig.binaryName,
      ...(testDir !== undefined ? { testDir } : {}),
    }),
    componentName
  );

  outro('Component created');
}
