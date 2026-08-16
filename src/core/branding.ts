// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FireForgeError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import type { ProjectLicense } from '../types/config.js';
import { copyDir, pathExists, readText, writeTextIfChanged } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { DEFAULT_LICENSE, getLicenseHeader } from './license-headers.js';

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
 * Error thrown when the generated `mozconfig` references a `--with-branding`
 * directory that does not match the branding tree FireForge set up. The
 * mismatch is a silent-corruption hazard — `mach configure` picks the value
 * from mozconfig but the scaffolded branding lives elsewhere, so the build
 * fails deep inside moz.build resolution with a confusing "path does not
 * exist" message. Surface it as an actionable preflight instead.
 *
 * The root cause is that setup renders templates under `configs/` with
 * `${binaryName}` baked in at setup time; a subsequent edit to
 * `fireforge.json`'s `binaryName` (or a re-setup without re-templating)
 * leaves those baked-in names stale while `setupBranding` continues to use
 * the current `config.binaryName`. Both directions (mozconfig ahead of
 * config, config ahead of mozconfig) produce the same class of build break.
 */
export class BrandingMozconfigMismatchError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  constructor(
    public readonly expectedBrandingDir: string,
    public readonly mozconfigBrandingDir: string,
    public readonly reason: 'mozconfig-missing-branding' | 'name-mismatch' | 'branding-dir-missing'
  ) {
    super(
      `Generated mozconfig references "${mozconfigBrandingDir}" but the active branding directory is "${expectedBrandingDir}".`
    );
  }

  override get userMessage(): string {
    const diagnosis =
      this.reason === 'mozconfig-missing-branding'
        ? `The generated mozconfig does not contain a --with-branding directive (found "${this.mozconfigBrandingDir}"). FireForge expected to write one for binaryName "${this.expectedBrandingDir}".`
        : this.reason === 'name-mismatch'
          ? `The generated mozconfig sets --with-branding="${this.mozconfigBrandingDir}" but FireForge set up branding under "${this.expectedBrandingDir}".`
          : `The generated mozconfig sets --with-branding="${this.mozconfigBrandingDir}" but no moz.build exists under engine/${this.mozconfigBrandingDir}/.`;

    return (
      `Branding Error: ${diagnosis}\n\n` +
      'This usually means the rendered configs/ templates drifted from fireforge.json. Fix one of:\n' +
      '  1. Edit configs/common.mozconfig so --with-branding uses ${binaryName} (or the current binaryName), then re-run "fireforge build".\n' +
      '  2. Update fireforge.json so binaryName matches the --with-branding value baked into configs/.\n\n' +
      'The mismatch is caught before mach builds because resolving the build against the wrong branding tree fails deep in moz.build with a confusing "path does not exist" message.'
    );
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
  /**
   * Project license (from fireforge.json). Used to stamp the generated
   * `configure.sh`, `brand.properties`, and `brand.ftl` files with the
   * matching header so `patch-lint` does not flag them for
   * `missing-license-header` when the project is not MPL-2.0. Optional for
   * backwards compatibility with pre-0.16 callers that did not thread the
   * license through — falls back to {@link DEFAULT_LICENSE}.
   */
  license?: ProjectLicense;
}

type VendorPlacement = 'branding-configure' | 'moz-configure';

/**
 * Splits the reverse-domain `appId` for macOS bundle identity. Upstream
 * `toolkit/moz.configure` composes `CFBundleIdentifier` as
 * `<--with-distribution-id>.<MOZ_MACBUNDLE_ID>` (the distribution id
 * defaults to `org.mozilla`), so branding `configure.sh` must carry only
 * the LEAF segment while the generated mozconfig carries the remainder as
 * `--with-distribution-id`. Writing the full appId into `MOZ_MACBUNDLE_ID`
 * double-prefixes the shipped bundle id (observed:
 * `org.mozilla.org.hominis.browser`, and with a distribution-id flag,
 * `org.hominis.org.hominis.browser`). Config validation guarantees a
 * reverse-domain id, so the split always has both halves.
 */
export function splitAppId(appId: string): { distributionId: string; leaf: string } {
  const lastDot = appId.lastIndexOf('.');
  return { distributionId: appId.slice(0, lastDot), leaf: appId.slice(lastDot + 1) };
}

const MOZ_APP_VENDOR_IMPLY_REGEX = /imply_option\("MOZ_APP_VENDOR",\s*"[^"]*"\)/;
const BRANDING_CONFIGURE_MANAGED_KEYS = new Set([
  'MOZ_APP_DISPLAYNAME',
  'MOZ_APP_VENDOR',
  'MOZ_MACBUNDLE_ID',
]);

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

  const vendorPlacement = await resolveVendorPlacement(engineDir);

  // Create/update configure.sh with custom values
  await createConfigureScript(brandingDir, config, vendorPlacement);

  // Update localization files
  await updateBrandProperties(brandingDir, config);
  await updateBrandFtl(brandingDir, config);

  // Patch moz.configure for MOZ_APP_VENDOR
  await patchMozConfigure(engineDir, config, vendorPlacement);
}

/**
 * Creates the branding configure.sh script.
 */
async function createConfigureScript(
  brandingDir: string,
  config: BrandingConfig,
  vendorPlacement: VendorPlacement
): Promise<void> {
  const configureShPath = join(brandingDir, 'configure.sh');
  const existing = (await pathExists(configureShPath))
    ? await readText(configureShPath)
    : undefined;
  await writeTextIfChanged(
    configureShPath,
    buildConfigureScriptContent(config, vendorPlacement, existing)
  );
}

function buildConfigureScriptContent(
  config: BrandingConfig,
  vendorPlacement: VendorPlacement,
  existingContent?: string
): string {
  const header = getLicenseHeader(config.license ?? DEFAULT_LICENSE, 'hash');
  const managedLines = [`MOZ_APP_DISPLAYNAME="${escapeShellValue(config.name)}"`];
  if (vendorPlacement === 'branding-configure') {
    managedLines.push(`MOZ_APP_VENDOR="${escapeShellValue(config.vendor)}"`);
  }
  managedLines.push(`MOZ_MACBUNDLE_ID="${escapeShellValue(splitAppId(config.appId).leaf)}"`);

  const preservedLines = existingContent ? extractPreservedConfigureLines(existingContent) : [];
  const body = [...managedLines, ...preservedLines].join('\n');
  return `${header}\n\n${body}\n`;
}

function extractPreservedConfigureLines(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (/^#\s*SPDX-License-Identifier:/i.test(trimmed)) return false;
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (keyMatch && BRANDING_CONFIGURE_MANAGED_KEYS.has(keyMatch[1] ?? '')) return false;
    return true;
  });
}

function parseConfigureAssignments(content: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      assignments.set(match[1], match[2]);
    }
  }
  return assignments;
}

function isConfigureScriptCurrent(
  content: string,
  config: BrandingConfig,
  vendorPlacement: VendorPlacement
): boolean {
  const assignments = parseConfigureAssignments(content);
  if (assignments.get('MOZ_APP_DISPLAYNAME') !== `"${escapeShellValue(config.name)}"`) {
    return false;
  }
  if (
    assignments.get('MOZ_MACBUNDLE_ID') !== `"${escapeShellValue(splitAppId(config.appId).leaf)}"`
  ) {
    return false;
  }
  const vendorValue = assignments.get('MOZ_APP_VENDOR');
  if (vendorPlacement === 'branding-configure') {
    return vendorValue === `"${escapeShellValue(config.vendor)}"`;
  }
  return vendorValue === undefined;
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

  await writeTextIfChanged(propsPath, buildBrandPropertiesContent(config));
}

function buildBrandPropertiesContent(config: BrandingConfig): string {
  const header = getLicenseHeader(config.license ?? DEFAULT_LICENSE, 'hash');
  return `${header}

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

  await writeTextIfChanged(ftlPath, buildBrandFtlContent(config));
}

function buildBrandFtlContent(config: BrandingConfig): string {
  const header = getLicenseHeader(config.license ?? DEFAULT_LICENSE, 'hash');
  return `${header}

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
 * Patches browser/moz.configure to set custom vendor when the upstream
 * configure surface owns MOZ_APP_VENDOR as a project flag. ESR 140 rejects
 * branding configure.sh / confvars origins for that flag, so the value must
 * come from imply_option.
 */
async function patchMozConfigure(
  engineDir: string,
  config: BrandingConfig,
  vendorPlacement: VendorPlacement
): Promise<void> {
  if (vendorPlacement !== 'moz-configure') {
    return;
  }
  const mozConfigurePath = join(engineDir, 'browser', 'moz.configure');

  if (!(await pathExists(mozConfigurePath))) {
    return;
  }

  let content = await readText(mozConfigurePath);

  if (MOZ_APP_VENDOR_IMPLY_REGEX.test(content)) {
    content = content.replace(MOZ_APP_VENDOR_IMPLY_REGEX, buildMozConfigureVendorLine(config));
  } else {
    content = insertMozConfigureVendorLine(content, buildMozConfigureVendorLine(config));
  }

  await writeTextIfChanged(mozConfigurePath, content);
}

function buildMozConfigureVendorLine(config: BrandingConfig): string {
  return `imply_option("MOZ_APP_VENDOR", "${escapeString(config.vendor)}")`;
}

async function resolveVendorPlacement(engineDir: string): Promise<VendorPlacement> {
  const mozConfigurePath = join(engineDir, 'browser', 'moz.configure');
  const toolkitMozConfigurePath = join(engineDir, 'toolkit', 'moz.configure');

  const browserMozConfigureExists = await pathExists(mozConfigurePath);
  const browserMozConfigureContent = browserMozConfigureExists
    ? await readText(mozConfigurePath)
    : undefined;

  if (
    browserMozConfigureContent !== undefined &&
    MOZ_APP_VENDOR_IMPLY_REGEX.test(browserMozConfigureContent)
  ) {
    return 'moz-configure';
  }

  if (await toolkitMozConfigureUsesVendorProjectFlag(toolkitMozConfigurePath)) {
    if (!browserMozConfigureExists) {
      throw new BrandingError(
        'Firefox toolkit configure declares MOZ_APP_VENDOR as a project_flag, but browser/moz.configure is missing, so FireForge cannot safely set the vendor identity.'
      );
    }
    return 'moz-configure';
  }

  return 'branding-configure';
}

async function toolkitMozConfigureUsesVendorProjectFlag(filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    return false;
  }
  const content = await readText(filePath);
  return /project_flag\(\s*(?:(?!\)\s*\n)[\s\S])*env\s*=\s*"MOZ_APP_VENDOR"/m.test(content);
}

function insertMozConfigureVendorLine(content: string, line: string): string {
  const includeRegex = /^include\((["'])\.\.\/toolkit\/moz\.configure\1\)\s*$/m;
  const match = includeRegex.exec(content);
  if (!match) {
    return `${content.replace(/\s*$/, '')}\n\n${line}\n`;
  }

  const prefix = content.slice(0, match.index).replace(/\s*$/, '');
  const suffix = content.slice(match.index);
  return `${prefix}\n\n${line}\n${suffix}`;
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

  if (!(await pathExists(configureShPath))) {
    return false;
  }

  const vendorPlacement = await resolveVendorPlacement(engineDir);
  const configureContent = await readText(configureShPath);
  if (!isConfigureScriptCurrent(configureContent, config, vendorPlacement)) {
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

  if (vendorPlacement === 'branding-configure') {
    return configureContent.includes(`MOZ_APP_VENDOR="${escapeShellValue(config.vendor)}"`);
  }

  const mozConfigurePath = join(engineDir, 'browser', 'moz.configure');
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
