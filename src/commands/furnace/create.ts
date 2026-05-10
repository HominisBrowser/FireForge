// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { text } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { resolveFtlChromeSubPath, tagNameToClassName } from '../../core/furnace-constants.js';
import {
  type FurnaceOperationContext,
  recordFurnaceRollbackFailure,
  runFurnaceMutation,
} from '../../core/furnace-operation.js';
import {
  CUSTOM_ELEMENT_TAG_PATTERN,
  CUSTOM_ELEMENT_TAG_RULES,
} from '../../core/furnace-registration-validate.js';
import {
  createRollbackJournal,
  recordCreatedDir,
  restoreRollbackJournalOrThrow,
  type RollbackJournal,
  snapshotFile,
} from '../../core/furnace-rollback.js';
import { isComponentInEngine } from '../../core/furnace-scanner.js';
import { DEFAULT_LICENSE, getLicenseHeader } from '../../core/license-headers.js';
import { registerTestManifest } from '../../core/manifest-register.js';
import { validateSharedFtl } from '../../core/shared-ftl.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceCreateOptions } from '../../types/commands/index.js';
import type { ProjectLicense } from '../../types/config.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { ensureDir, pathExists, readText, writeText } from '../../utils/fs.js';
import { cancel, intro, isCancel, note, outro, success, warn } from '../../utils/logger.js';
import { formatDryRunPlan, formatSuccessNote } from './create-dry-run.js';
import { resolveCreateFeatures } from './create-features.js';
import { scaffoldMochikitTestFiles } from './create-mochikit.js';
import { assertCustomEntryPersisted } from './create-readback.js';
import { generateCssContent, generateFtlContent, generateMjsContent } from './create-templates.js';
import { validateCreateAgainstConfig } from './create-validation.js';
import { scaffoldXpcshellTestFiles } from './create-xpcshell.js';

async function loadAuthoringFurnaceConfig(projectRoot: string): Promise<FurnaceConfig> {
  if (await furnaceConfigExists(projectRoot)) {
    return loadFurnaceConfig(projectRoot);
  }

  return createDefaultFurnaceConfig();
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

/**
 * Scaffolds browser mochitest files for a newly created custom component.
 * @param componentName - Custom element tag name
 * @param license - Project license used for generated headers
 * @param forgeConfig - Project config fields needed for test naming
 * @param paths - Resolved project paths used to place test files
 * @param journal - Optional rollback journal that snapshots files before writes
 * @returns Relative test filenames created or updated for the component
 */
async function scaffoldTestFiles(
  componentName: string,
  license: ProjectLicense,
  forgeConfig: { binaryName: string },
  paths: { engine: string },
  journal?: RollbackJournal
): Promise<string[]> {
  const strippedName = componentName.startsWith('moz-') ? componentName.slice(4) : componentName;
  // Avoid double-prefixing: strip binaryName prefix since testDirName already uses it
  const testDirName = forgeConfig.binaryName;
  const withoutBinaryPrefix = strippedName.startsWith(testDirName + '-')
    ? strippedName.slice(testDirName.length + 1)
    : strippedName;
  const underscored = withoutBinaryPrefix.replace(/-/g, '_');
  const testFileName = `browser_${testDirName}_${underscored}.js`;
  const testDir = join(paths.engine, 'browser/base/content/test', testDirName);
  if (journal && !(await pathExists(testDir))) {
    recordCreatedDir(journal, testDir);
  }
  await ensureDir(testDir);

  const jsHeader = getLicenseHeader(license, 'js');
  const hashHeader = getLicenseHeader(license, 'hash');
  const testFiles: string[] = [];

  // browser.toml — create if missing, append entry if existing
  const tomlPath = join(testDir, 'browser.toml');
  if (await pathExists(tomlPath)) {
    // Defensive guard: only append if the entry is not already present.
    // With a fresh journal per create, the same test file name cannot be
    // appended twice in a single run — but retaining the check protects
    // against accidental re-entrance or a future refactor that reuses the
    // helper with a stale test directory.
    const existingToml = await readText(tomlPath);
    if (!existingToml.includes(`["${testFileName}"]`)) {
      if (journal) await snapshotFile(journal, tomlPath);
      await writeText(tomlPath, existingToml.trimEnd() + `\n\n["${testFileName}"]\n`);
    }
  } else {
    if (journal) await snapshotFile(journal, tomlPath);
    const browserToml = `${hashHeader}

[DEFAULT]
support-files = ["head.js"]

["${testFileName}"]
`;
    await writeText(tomlPath, browserToml);
  }
  testFiles.push('browser.toml');

  // head.js — only create if it doesn't exist (shared across components)
  const headPath = join(testDir, 'head.js');
  if (!(await pathExists(headPath))) {
    if (journal) await snapshotFile(journal, headPath);
    const headJs = `${jsHeader}

"use strict";

/**
 * Wait for a custom element to be defined.
 * @param {string} tag - Custom element tag name
 * @returns {Promise<CustomElementConstructor>}
 */
async function waitForElement(tag) {
  return customElements.whenDefined(tag);
}
`;
    await writeText(headPath, headJs);
    testFiles.push('head.js');
  }

  // browser_{binaryName}_{stripped}.js
  const testJs = `${jsHeader}

"use strict";

add_task(async function test_${underscored}_defined() {
  const ctor = await waitForElement("${componentName}");
  Assert.ok(ctor, "${componentName} custom element should be defined");
  Assert.equal(typeof ctor, "function", "Constructor should be a function");
});
`;
  const testFilePath = join(testDir, testFileName);
  if (journal) await snapshotFile(journal, testFilePath);
  await writeText(testFilePath, testJs);
  testFiles.push(testFileName);

  // Register in moz.build. The registration helper edits browser/base/moz.build,
  // so snapshot it first when a journal is supplied. The existing warn-and-continue
  // contract is preserved so a missing/unparseable moz.build never trips rollback.
  try {
    const mozBuildPath = join(paths.engine, 'browser/base/moz.build');
    if (journal) await snapshotFile(journal, mozBuildPath);
    const registerResult = await registerTestManifest(paths.engine, testDirName);
    if (!registerResult.skipped) {
      success(`Registered test manifest in ${registerResult.manifest}`);
    }
  } catch (error: unknown) {
    warn(
      `Could not register test manifest in moz.build — ${toError(error).message}. Register manually with "fireforge register".`
    );
  }

  return testFiles;
}

/**
 * Writes the scaffolded component source files to disk.
 * @param componentDir - Destination component directory
 * @param componentName - Custom element tag name
 * @param className - Generated component class name
 * @param description - Human-readable component description
 * @param localized - Whether to include a Fluent file
 * @param license - Project license used for generated headers
 * @param journal - Optional rollback journal that snapshots files before writes
 * @returns Relative filenames written for the component
 */
async function writeComponentFiles(
  componentDir: string,
  componentName: string,
  className: string,
  description: string,
  localized: boolean,
  license: ProjectLicense,
  ftlChromeSubPath: string | undefined,
  sharedFtl: string | undefined,
  journal?: RollbackJournal
): Promise<string[]> {
  await ensureDir(componentDir);

  const files = [`${componentName}.mjs`, `${componentName}.css`];

  const mjsPath = join(componentDir, `${componentName}.mjs`);
  if (journal) await snapshotFile(journal, mjsPath);
  const mjsContent = generateMjsContent(
    componentName,
    className,
    description,
    localized,
    getLicenseHeader(license, 'js'),
    ftlChromeSubPath,
    sharedFtl
  );
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

/** Resolved test-harness selection for a `furnace create` run. */
export type ResolvedTestStyle = 'mochikit' | 'browser-chrome' | 'xpcshell' | 'none';

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
    validateCreateAgainstConfig(
      freshConfig,
      args.componentName,
      args.allowPrefixMismatch,
      args.composes
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
    files = await writeComponentFiles(
      args.componentDir,
      args.componentName,
      args.className,
      args.description,
      args.localized,
      args.license,
      resolveFtlChromeSubPath(freshConfig.ftlBasePath),
      args.sharedFtl,
      journal
    );

    const customEntry: import('../../types/furnace.js').CustomComponentConfig = {
      description: args.description,
      targetPath: `toolkit/content/widgets/${args.componentName}`,
      register: args.register,
      localized: args.localized,
    };
    if (args.composes && args.composes.length > 0) {
      customEntry.composes = args.composes;
    }
    if (args.sharedFtl) {
      customEntry.sharedFtl = args.sharedFtl;
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
        journal
      );
      testFiles.push(...scafFiles);
    } else if (args.testStyle === 'xpcshell') {
      const xpcshellFiles = await scaffoldXpcshellTestFiles(
        args.componentName,
        args.license,
        args.forgeConfig,
        args.paths,
        journal
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
    try {
      await restoreRollbackJournalOrThrow(
        journal,
        `Failed to create custom component "${args.componentName}"`
      );
    } catch (rollbackError) {
      await recordFurnaceRollbackFailure(
        args.projectRoot,
        'create-rollback',
        `component "${args.componentName}": ${toError(rollbackError).message}`
      );
      throw rollbackError;
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
      description = String(descResult);
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
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
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
      validate: (value) => validateTagName(value ?? ''),
    });

    if (isCancel(nameResult)) {
      cancel('Create cancelled');
      return;
    }

    componentName = String(nameResult);
  }

  // Load the current furnace config only after the interactive name prompt
  // succeeds so a cancelled create in a fresh project does not strand a new
  // furnace.json behind.
  const config = await loadAuthoringFurnaceConfig(projectRoot);

  const composes = options.compose;
  validateCreateAgainstConfig(config, componentName, options.allowPrefixMismatch, composes);

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

  // --- Normalize and validate --shared-ftl ahead of any writes. Shares the
  // structural rules with furnace-config.ts so the command and the on-disk
  // schema cannot diverge. Pass the resolved `localized` rather than a
  // `true` literal so the validator's cross-field check stays anchored to
  // the real feature selection — `resolveCreateFeatures` promotes localized
  // upstream, but hard-coding `true` here would hide a regression if that
  // promotion ever moved or dropped.
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
      // Spread rather than assign so the key is absent when sharedFtl is
      // undefined — the DryRunPlanInput type uses strict-optional shape.
      ...(sharedFtl !== undefined ? { sharedFtl } : {}),
      testStyle,
      description,
      binaryName: forgeConfig.binaryName,
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
    }),
    componentName
  );

  outro('Component created');
}
