// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { multiselect, text } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  createDefaultFurnaceConfig,
  detectComposesCycles,
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { tagNameToClassName } from '../../core/furnace-constants.js';
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
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceCreateOptions } from '../../types/commands/index.js';
import type { ProjectLicense } from '../../types/config.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { toError } from '../../utils/errors.js';
import { ensureDir, pathExists, readText, writeText } from '../../utils/fs.js';
import { cancel, intro, isCancel, note, outro, success, warn } from '../../utils/logger.js';

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
 * Checks if a component name conflicts with existing entries in furnace.json.
 */
function checkNameConflict(config: FurnaceConfig, name: string): string | undefined {
  if (name in config.custom) {
    return `A custom component named "${name}" already exists in furnace.json`;
  }
  if (name in config.overrides) {
    return `An override component named "${name}" already exists in furnace.json`;
  }
  return undefined;
}

/**
 * Generates the .mjs file content for a custom component.
 */
function generateMjsContent(
  name: string,
  className: string,
  description: string,
  localized: boolean,
  header: string
): string {
  const connectedCallback = localized
    ? `
  connectedCallback() {
    super.connectedCallback();
    this.insertFTLIfNeeded("${name}.ftl");
  }
`
    : '';

  return `${header}

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * ${description || name}
 *
 * @tagname ${name}
 */
class ${className} extends MozLitElement {
  static properties = {};

  constructor() {
    super();
  }
${connectedCallback}
  render() {
    return html\`
      <link rel="stylesheet" href="chrome://global/content/elements/${name}.css" />
      <slot></slot>
    \`;
  }
}
customElements.define("${name}", ${className});
`;
}

/**
 * Generates the .css file content for a custom component.
 */
function generateCssContent(header: string): string {
  return `${header}

:host {
  display: block;
}
`;
}

/**
 * Generates the .ftl file content for a custom component.
 */
function generateFtlContent(name: string, header: string): string {
  return `${header}

## Strings for the ${name} component
`;
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
    // Append the new test entry if not already present
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
 * Resolves the localized and registration feature flags for a new component.
 * @param isInteractive - Whether interactive prompts are available
 * @param options - CLI-provided feature flags
 * @returns Final feature selections, or null when creation is cancelled
 */
async function resolveCreateFeatures(
  isInteractive: boolean,
  options: FurnaceCreateOptions
): Promise<{ localized: boolean; register: boolean } | null> {
  let localized = options.localized ?? false;
  let register = options.register ?? true;

  if (isInteractive && options.localized === undefined && options.register === undefined) {
    const features = await multiselect({
      message: 'Component features:',
      options: [
        {
          value: 'localized',
          label: 'Fluent localization (data-l10n-id)',
        },
        {
          value: 'register',
          label: 'Register in customElements.js',
        },
      ],
      initialValues: ['register'],
    });

    if (isCancel(features)) {
      cancel('Create cancelled');
      return null;
    }

    const selected = features as string[];
    localized = selected.includes('localized');
    register = selected.includes('register');
  }

  return { localized, register };
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
    getLicenseHeader(license, 'js')
  );
  await writeText(mjsPath, mjsContent);

  const cssPath = join(componentDir, `${componentName}.css`);
  if (journal) await snapshotFile(journal, cssPath);
  const cssContent = generateCssContent(getLicenseHeader(license, 'css'));
  await writeText(cssPath, cssContent);

  if (localized) {
    const ftlPath = join(componentDir, `${componentName}.ftl`);
    if (journal) await snapshotFile(journal, ftlPath);
    const ftlContent = generateFtlContent(componentName, getLicenseHeader(license, 'hash'));
    await writeText(ftlPath, ftlContent);
    files.push(`${componentName}.ftl`);
  }

  return files;
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
  componentDir: string;
  furnacePaths: { furnaceConfig: string };
  config: FurnaceConfig;
  forgeConfig: { binaryName: string };
  paths: { engine: string };
  license: ProjectLicense;
  withTests: boolean;
  operationContext?: FurnaceOperationContext;
}): Promise<{ files: string[]; testFiles: string[] }> {
  const journal = createRollbackJournal();
  if (args.operationContext) {
    args.operationContext.registerJournal(journal);
  }
  recordCreatedDir(journal, args.componentDir);

  const testFiles: string[] = [];
  let files: string[];

  try {
    files = await writeComponentFiles(
      args.componentDir,
      args.componentName,
      args.className,
      args.description,
      args.localized,
      args.license,
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
    args.config.custom[args.componentName] = customEntry;

    await snapshotFile(journal, args.furnacePaths.furnaceConfig);
    await writeFurnaceConfig(args.projectRoot, args.config);

    if (args.withTests) {
      const scafFiles = await scaffoldTestFiles(
        args.componentName,
        args.license,
        args.forgeConfig,
        args.paths,
        journal
      );
      testFiles.push(...scafFiles);
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

  intro('Furnace Create');

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

  // Check for conflicts
  const conflict = checkNameConflict(config, componentName);
  if (conflict) {
    throw new FurnaceError(conflict, componentName);
  }

  // Check if it already exists in the engine source tree
  if (await pathExists(paths.engine)) {
    if (await isComponentInEngine(paths.engine, componentName)) {
      throw new FurnaceError(
        `"${componentName}" already exists in the engine source tree. Use "fireforge furnace override" instead.`,
        componentName
      );
    }
  }

  // Warn if name doesn't match componentPrefix
  if (config.componentPrefix && !componentName.startsWith(config.componentPrefix)) {
    warn(
      `Name "${componentName}" does not start with the configured prefix "${config.componentPrefix}".`
    );
  }

  // --- Resolve description ---
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

  // --- Resolve features ---
  const featureSelection = await resolveCreateFeatures(isInteractive, options);
  if (!featureSelection) {
    return;
  }
  const { localized, register } = featureSelection;

  // --with-tests writes files under engine/browser/base/content/test/ and
  // registers them in moz.build. Guard against a missing engine now rather
  // than letting scaffoldTestFiles fabricate a partial engine tree with
  // ensureDir.
  const withTests = options.withTests ?? false;
  if (withTests && !(await pathExists(paths.engine))) {
    throw new FurnaceError(
      'Engine directory not found. Run "fireforge download" first to use --with-tests.',
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

  // --- Validate --compose targets BEFORE any writes so a failed validation
  // does not strand component files behind.
  const composes = options.compose;
  if (composes && composes.length > 0) {
    const known = new Set([
      ...config.stock,
      ...Object.keys(config.overrides),
      ...Object.keys(config.custom),
    ]);
    for (const tag of composes) {
      if (tag === componentName) {
        throw new FurnaceError(`Component "${componentName}" cannot compose itself.`);
      }
      if (!known.has(tag)) {
        throw new FurnaceError(
          `Cannot compose unknown component "${tag}". ` +
            'The referenced component must be registered as stock, override, or custom.'
        );
      }
    }

    // Check for cycles that would be introduced by adding this component.
    const tempCustom: FurnaceConfig['custom'] = {
      ...config.custom,
      [componentName]: {
        description: '',
        targetPath: `toolkit/content/widgets/${componentName}`,
        register: true,
        localized: false,
        composes,
      },
    };
    detectComposesCycles(tempCustom);
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
      componentDir,
      furnacePaths,
      config,
      forgeConfig,
      paths,
      license,
      withTests,
      operationContext: ctx,
    })
  );

  // --- Success ---
  let noteParts =
    `Files created in components/custom/${componentName}/:\n` +
    files.map((f) => `  ${f}`).join('\n');

  if (testFiles.length > 0) {
    noteParts +=
      `\n\nTest files in engine/browser/base/content/test/${forgeConfig.binaryName}/:\n` +
      testFiles.map((f) => `  ${f}`).join('\n');
  }

  noteParts +=
    '\n\n' +
    'Next steps:\n' +
    `  1. Edit component files in components/custom/${componentName}/\n` +
    '  2. Run "fireforge furnace preview" to see it\n' +
    '  3. Run "fireforge build" to apply and build';

  note(noteParts, componentName);

  outro('Component created');
}
