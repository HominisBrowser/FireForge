// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FireForgeError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import { copyDir, pathExists, readText, writeText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';

/**
 * Error thrown when branding operations fail.
 */
export class BrandingError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  override get userMessage(): string {
    return `Branding Error: ${this.message}\n\nBranding is required to set MOZ_APP_VENDOR, MOZ_MACBUNDLE_ID, and other Firefox identity values.`;
  }
}

/**
 * Full branding configuration.
 */
export interface BrandingConfig {
  /** Display name (e.g., "MyBrowser") */
  name: string;
  /** Vendor name (e.g., "My Company") */
  vendor: string;
  /** Application ID in reverse-domain format (e.g., "org.mybrowser.browser") */
  appId: string;
  /** Binary/branding directory name (e.g., "mybrowser") */
  binaryName: string;
}

/**
 * Sets up the custom branding directory for the browser.
 *
 * This creates a branding directory based on Firefox's unofficial branding,
 * with customized values for:
 * - configure.sh: MOZ_APP_DISPLAYNAME, MOZ_MACBUNDLE_ID
 * - brand.properties: brandShorterName, brandShortName, brandFullName
 * - brand.ftl: -brand-shorter-name, -brand-short-name, etc.
 *
 * @param engineDir - Path to the engine directory
 * @param config - Branding configuration
 */
export async function setupBranding(engineDir: string, config: BrandingConfig): Promise<void> {
  const brandingDir = join(engineDir, 'browser', 'branding', config.binaryName);
  const unofficialDir = join(engineDir, 'browser', 'branding', 'unofficial');

  // Check if unofficial branding exists as our base
  if (!(await pathExists(unofficialDir))) {
    throw new BrandingError(`Unofficial branding directory not found at ${unofficialDir}`);
  }

  // Copy unofficial branding as base (if our branding doesn't exist yet)
  if (!(await pathExists(brandingDir))) {
    await copyDir(unofficialDir, brandingDir);
  }

  // Create/update configure.sh with custom values
  await createConfigureScript(brandingDir, config);

  // Update localization files
  await updateBrandProperties(brandingDir, config);
  await updateBrandFtl(brandingDir, config);

  // Patch moz.configure for MOZ_APP_VENDOR
  await patchMozConfigure(engineDir, config);
}

/**
 * Creates the branding configure.sh script.
 */
async function createConfigureScript(brandingDir: string, config: BrandingConfig): Promise<void> {
  const configureShPath = join(brandingDir, 'configure.sh');
  await writeText(configureShPath, buildConfigureScriptContent(config));
}

function buildConfigureScriptContent(config: BrandingConfig): string {
  return `# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME="${escapeShellValue(config.name)}"
MOZ_MACBUNDLE_ID="${escapeShellValue(config.appId)}"
`;
}

/**
 * Updates the brand.properties localization file.
 */
async function updateBrandProperties(brandingDir: string, config: BrandingConfig): Promise<void> {
  const propsPath = join(brandingDir, 'locales', 'en-US', 'brand.properties');

  if (!(await pathExists(propsPath))) {
    warn('brand.properties not found in branding directory — browser will use default strings');
    return;
  }

  await writeText(propsPath, buildBrandPropertiesContent(config));
}

function buildBrandPropertiesContent(config: BrandingConfig): string {
  return `# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

brandShorterName=${escapePropertiesValue(config.name)}
brandShortName=${escapePropertiesValue(config.name)}
brandFullName=${escapePropertiesValue(config.name)}
`;
}

/**
 * Updates the brand.ftl localization file.
 */
async function updateBrandFtl(brandingDir: string, config: BrandingConfig): Promise<void> {
  const ftlPath = join(brandingDir, 'locales', 'en-US', 'brand.ftl');

  if (!(await pathExists(ftlPath))) {
    warn('brand.ftl not found in branding directory — browser will use default strings');
    return;
  }

  await writeText(ftlPath, buildBrandFtlContent(config));
}

function buildBrandFtlContent(config: BrandingConfig): string {
  return `# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Brand names
##
## These brand names can be used in messages.

-brand-shorter-name = ${escapeFtlValue(config.name)}
-brand-short-name = ${escapeFtlValue(config.name)}
-brand-shortcut-name = ${escapeFtlValue(config.name)}
-brand-full-name = ${escapeFtlValue(config.name)}
-brand-product-name = ${escapeFtlValue(config.name)}
-vendor-short-name = ${escapeFtlValue(config.vendor)}
trademarkInfo = { " " }
`;
}

/**
 * Patches browser/moz.configure to set custom vendor.
 *
 * Mozilla's build system requires MOZ_APP_VENDOR to be set via imply_option
 * in moz.configure, not through mozconfig.
 */
async function patchMozConfigure(engineDir: string, config: BrandingConfig): Promise<void> {
  const mozConfigurePath = join(engineDir, 'browser', 'moz.configure');

  if (!(await pathExists(mozConfigurePath))) {
    throw new BrandingError(`browser/moz.configure not found at ${mozConfigurePath}`);
  }

  let content = await readText(mozConfigurePath);

  // Replace MOZ_APP_VENDOR imply_option
  const vendorRegex = /imply_option\("MOZ_APP_VENDOR",\s*"[^"]*"\)/;
  if (!vendorRegex.test(content)) {
    throw new BrandingError('Could not find MOZ_APP_VENDOR imply_option in browser/moz.configure');
  }
  content = content.replace(vendorRegex, buildMozConfigureVendorLine(config));

  await writeText(mozConfigurePath, content);
}

function buildMozConfigureVendorLine(config: BrandingConfig): string {
  return `imply_option("MOZ_APP_VENDOR", "${escapeString(config.vendor)}")`;
}

/**
 * Escapes a string for use in Python/configure file.
 */
function escapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Escapes a string for use inside a shell double-quoted context.
 * Prevents command injection via $, backticks, !, and escape sequences.
 */
function escapeShellValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

/**
 * Escapes a string for use in .properties file values.
 * Prevents key/value injection via = and : delimiters.
 */
function escapePropertiesValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Escapes a string for use in Fluent (.ftl) file values.
 * Prevents placeables injection via { and }.
 */
function escapeFtlValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Checks if branding has been set up for the given configuration.
 *
 * @param engineDir - Path to the engine directory
 * @param config - Branding configuration to check for
 * @returns true if branding is already set up
 */
export async function isBrandingSetup(engineDir: string, config: BrandingConfig): Promise<boolean> {
  const brandingDir = join(engineDir, 'browser', 'branding', config.binaryName);
  const configureShPath = join(brandingDir, 'configure.sh');
  const propsPath = join(brandingDir, 'locales', 'en-US', 'brand.properties');
  const ftlPath = join(brandingDir, 'locales', 'en-US', 'brand.ftl');
  const mozConfigurePath = join(engineDir, 'browser', 'moz.configure');

  if (!(await pathExists(configureShPath))) {
    return false;
  }

  const configureContent = await readText(configureShPath);
  if (configureContent !== buildConfigureScriptContent(config)) {
    return false;
  }

  if (await pathExists(propsPath)) {
    const propsContent = await readText(propsPath);
    if (propsContent !== buildBrandPropertiesContent(config)) {
      return false;
    }
  }

  if (await pathExists(ftlPath)) {
    const ftlContent = await readText(ftlPath);
    if (ftlContent !== buildBrandFtlContent(config)) {
      return false;
    }
  }

  if (!(await pathExists(mozConfigurePath))) {
    return false;
  }

  const mozConfigureContent = await readText(mozConfigurePath);
  return mozConfigureContent.includes(buildMozConfigureVendorLine(config));
}

/**
 * Checks whether a file path belongs to the tool-managed branding directory.
 * @param file - File path (relative to engine root)
 * @param binaryName - The configured binary name (used as branding directory name)
 * @returns true if the path is managed by branding tooling
 */
export function isBrandingManagedPath(file: string, binaryName: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const brandingRoot = `browser/branding/${binaryName}`;

  return (
    normalized === 'browser/moz.configure' ||
    normalized === brandingRoot ||
    normalized === `${brandingRoot}/` ||
    normalized.startsWith(`${brandingRoot}/`)
  );
}
