// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { multiselect, text } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  ensureFurnaceConfig,
  getFurnacePaths,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
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

/**
 * Converts a kebab-case tag name to PascalCase class name.
 * e.g. "moz-sidebar-panel" → "MozSidebarPanel"
 */
function tagNameToClassName(tagName: string): string {
  return tagName
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * Validates a custom element tag name.
 * @returns Error message if invalid, undefined if valid
 */
function validateTagName(name: string): string | undefined {
  if (!name.trim()) return 'Name is required';
  if (!name.includes('-')) return 'Custom element names must contain a hyphen (e.g., "my-widget")';
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name))
    return 'Name must be lowercase, start with a letter, and use hyphens to separate words (e.g., "my-widget")';
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
 * @returns Relative test filenames created or updated for the component
 */
async function scaffoldTestFiles(
  componentName: string,
  license: ProjectLicense,
  forgeConfig: { binaryName: string },
  paths: { engine: string }
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
      await writeText(tomlPath, existingToml.trimEnd() + `\n\n["${testFileName}"]\n`);
    }
  } else {
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
  await writeText(join(testDir, testFileName), testJs);
  testFiles.push(testFileName);

  // Register in moz.build
  try {
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
 * @returns Relative filenames written for the component
 */
async function writeComponentFiles(
  componentDir: string,
  componentName: string,
  className: string,
  description: string,
  localized: boolean,
  license: ProjectLicense
): Promise<string[]> {
  await ensureDir(componentDir);

  const files = [`${componentName}.mjs`, `${componentName}.css`];

  const mjsContent = generateMjsContent(
    componentName,
    className,
    description,
    localized,
    getLicenseHeader(license, 'js')
  );
  await writeText(join(componentDir, `${componentName}.mjs`), mjsContent);

  const cssContent = generateCssContent(getLicenseHeader(license, 'css'));
  await writeText(join(componentDir, `${componentName}.css`), cssContent);

  if (localized) {
    const ftlContent = generateFtlContent(componentName, getLicenseHeader(license, 'hash'));
    await writeText(join(componentDir, `${componentName}.ftl`), ftlContent);
    files.push(`${componentName}.ftl`);
  }

  return files;
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

  // Load or create furnace.json
  const config = await ensureFurnaceConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const forgeConfig = await loadConfig(projectRoot);
  const license = forgeConfig.license ?? DEFAULT_LICENSE;
  const furnacePaths = getFurnacePaths(projectRoot);

  // --- Resolve component name ---
  let componentName = name;

  if (componentName) {
    // Validate CLI-provided name
    const validationError = validateTagName(componentName);
    if (validationError) {
      throw new InvalidArgumentError(validationError, 'name');
    }
  } else if (isInteractive) {
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
  } else {
    throw new InvalidArgumentError(
      'Component name is required in non-interactive mode.\n' +
        'Usage: fireforge furnace create <name> -d "description"',
      'name'
    );
  }

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

  const files = await writeComponentFiles(
    componentDir,
    componentName,
    className,
    description,
    localized,
    license
  );

  // --- Validate and process --compose ---
  const composes = options.compose;
  if (composes && composes.length > 0) {
    for (const tag of composes) {
      if (!config.stock.includes(tag)) {
        warn(`Composed tag "${tag}" is not in the stock array of furnace.json.`);
      }
    }
  }

  // --- Update furnace.json ---
  const customEntry: import('../../types/furnace.js').CustomComponentConfig = {
    description,
    targetPath: `toolkit/content/widgets/${componentName}`,
    register,
    localized,
  };
  if (composes && composes.length > 0) {
    customEntry.composes = composes;
  }
  config.custom[componentName] = customEntry;

  await writeFurnaceConfig(projectRoot, config);

  // --- Scaffold tests if requested ---
  const withTests = options.withTests ?? false;
  const testFiles: string[] = [];

  if (withTests) {
    const scafFiles = await scaffoldTestFiles(componentName, license, forgeConfig, paths);
    testFiles.push(...scafFiles);
  }

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
