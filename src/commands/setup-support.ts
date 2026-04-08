// SPDX-License-Identifier: EUPL-1.2
import { cpus } from 'node:os';
import { join } from 'node:path';

import { group, select, text } from '@clack/prompts';

import { getProjectPaths, writeConfig } from '../core/config.js';
import { CancellationError, InvalidArgumentError } from '../errors/base.js';
import type { SetupOptions } from '../types/commands/index.js';
import type { FireForgeConfig, FirefoxProduct, ProjectLicense } from '../types/config.js';
import { ensureDir, pathExists, readText, writeText } from '../utils/fs.js';
import { cancel } from '../utils/logger.js';
import { getPackageRoot } from '../utils/package-root.js';
import {
  inferProductFromVersion,
  isValidAppId,
  isValidFirefoxVersion,
  isValidProjectLicense,
} from '../utils/validation.js';

export interface ResolvedSetupInputs {
  finalName: string;
  finalVendor: string;
  finalAppId: string;
  finalBinaryName: string;
  finalFirefoxVersion: string;
  finalProduct: FirefoxProduct;
  finalLicense: ProjectLicense;
}

function getTemplatesDir(): string {
  return join(getPackageRoot(), 'templates');
}

function renderLicenseTemplate(
  license: ProjectLicense,
  template: string,
  vendor: string,
  now: Date = new Date()
): string {
  if (license !== '0BSD') {
    return template;
  }

  return template.replace(/\[year\]/g, String(now.getFullYear())).replace(/\[fullname\]/g, vendor);
}

function resolveFirefoxProduct(value: unknown, field: string): FirefoxProduct {
  if (value === 'firefox' || value === 'firefox-esr' || value === 'firefox-beta') {
    return value;
  }

  throw new InvalidArgumentError(
    'Invalid product (use: firefox, firefox-esr, firefox-beta)',
    field
  );
}

function resolveProjectLicense(value: unknown, field: string): ProjectLicense {
  if (typeof value === 'string' && isValidProjectLicense(value)) {
    return value;
  }

  throw new InvalidArgumentError(
    'Invalid license (use: EUPL-1.2, MPL-2.0, 0BSD, GPL-2.0-or-later)',
    field
  );
}

/** Parses an optional Firefox product flag into a typed product value. */
export function parseFirefoxProductOption(product: string | undefined): FirefoxProduct | undefined {
  if (product === undefined) {
    return undefined;
  }

  return resolveFirefoxProduct(product, '--product');
}

/** Parses an optional license flag into a validated SPDX identifier. */
export function parseProjectLicenseOption(license: string | undefined): ProjectLicense | undefined {
  if (license === undefined) {
    return undefined;
  }

  return resolveProjectLicense(license, '--license');
}

/** Validates non-interactive setup options before project scaffolding begins. */
export function validateSetupOptions(options: SetupOptions): void {
  if (options.name !== undefined) {
    if (!options.name.trim()) {
      throw new InvalidArgumentError('Name is required', '--name');
    }
    if (options.name.length > 50) {
      throw new InvalidArgumentError('Name must be 50 characters or less', '--name');
    }
  }
  if (options.vendor !== undefined && !options.vendor.trim()) {
    throw new InvalidArgumentError('Vendor is required', '--vendor');
  }
  if (options.appId !== undefined && !isValidAppId(options.appId)) {
    throw new InvalidArgumentError(
      'Invalid app ID format (use reverse-domain: org.example.browser)',
      '--app-id'
    );
  }
  if (options.binaryName !== undefined && !/^[a-z][a-z0-9-]*$/.test(options.binaryName)) {
    throw new InvalidArgumentError(
      'Binary name must start with a letter and contain only lowercase letters, numbers, and hyphens',
      '--binary-name'
    );
  }
  if (options.firefoxVersion !== undefined && !isValidFirefoxVersion(options.firefoxVersion)) {
    throw new InvalidArgumentError(
      'Invalid Firefox version format (e.g., 146.0, 140.0esr, or 147.0b1)',
      '--firefox-version'
    );
  }
  if (options.product !== undefined) {
    resolveFirefoxProduct(options.product, '--product');
  }
  if (options.license !== undefined) {
    resolveProjectLicense(options.license, '--license');
  }
}

async function promptSetupInputs(options: SetupOptions): Promise<ResolvedSetupInputs> {
  const project = await group(
    {
      name: () =>
        options.name
          ? Promise.resolve(options.name)
          : text({
              message: 'What is the name of your browser?',
              placeholder: 'MyBrowser',
              validate: (value) => {
                const normalizedValue = value ?? '';
                if (!normalizedValue.trim()) return 'Name is required';
                if (normalizedValue.length > 50) return 'Name must be 50 characters or less';
                return undefined;
              },
            }),

      vendor: () =>
        options.vendor
          ? Promise.resolve(options.vendor)
          : text({
              message: 'What is your vendor/company name?',
              placeholder: 'My Company',
              validate: (value) => {
                if (!(value ?? '').trim()) return 'Vendor is required';
                return undefined;
              },
            }),

      appId: ({ results }) =>
        options.appId
          ? Promise.resolve(options.appId)
          : text({
              message: 'Application ID (reverse-domain format)',
              placeholder: `org.${(results.name ?? 'browser').toLowerCase().replace(/[^a-z0-9]/g, '')}.browser`,
              validate: (value) => {
                if (value && !isValidAppId(value)) {
                  return 'Must be in reverse-domain format (e.g., org.example.browser)';
                }
                return undefined;
              },
            }),

      binaryName: ({ results }) =>
        options.binaryName
          ? Promise.resolve(options.binaryName)
          : text({
              message: 'Binary name (executable name)',
              placeholder: (results.name ?? 'browser').toLowerCase().replace(/[^a-z0-9]/g, ''),
              validate: (value) => {
                if (value && !/^[a-z][a-z0-9-]*$/.test(value)) {
                  return 'Must start with a letter and contain only lowercase letters, numbers, and hyphens';
                }
                return undefined;
              },
            }),

      firefoxVersion: () =>
        options.firefoxVersion
          ? Promise.resolve(options.firefoxVersion)
          : text({
              message: 'Firefox version to base on',
              placeholder: '140.0esr',
              validate: (value) => {
                if (value && !isValidFirefoxVersion(value)) {
                  return 'Invalid Firefox version format (e.g., 146.0, 140.0esr, or 147.0b1)';
                }
                return undefined;
              },
            }),

      product: ({ results }) => {
        if (options.product) {
          return Promise.resolve(options.product);
        }

        const effectiveVersion =
          (typeof results.firefoxVersion === 'string' && results.firefoxVersion.trim()) ||
          options.firefoxVersion ||
          '140.0esr';
        const inferredProduct = inferProductFromVersion(effectiveVersion);
        if (inferredProduct) {
          return Promise.resolve(inferredProduct);
        }

        return select({
          message: 'Which Firefox product?',
          options: [
            { value: 'firefox', label: 'Firefox (stable releases)' },
            { value: 'firefox-esr', label: 'Firefox ESR (extended support)' },
            { value: 'firefox-beta', label: 'Firefox Beta (pre-release)' },
          ],
        });
      },

      license: () =>
        options.license
          ? Promise.resolve(options.license)
          : select({
              message: 'Project license',
              options: [
                {
                  value: 'EUPL-1.2',
                  label: 'EUPL 1.2 (recommended)',
                  hint: 'copyleft, MPL-2.0 compatible',
                },
                { value: 'MPL-2.0', label: 'MPL 2.0', hint: 'file-level copyleft' },
                { value: '0BSD', label: '0BSD', hint: 'permissive, no conditions' },
                { value: 'GPL-2.0-or-later', label: 'GPL 2.0+', hint: 'strong copyleft' },
              ],
              initialValue: 'EUPL-1.2',
            }),
    },
    {
      onCancel: () => {
        cancel('Setup cancelled');
        throw new CancellationError();
      },
    }
  );

  const sanitizedName = project.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const finalName = project.name;
  const finalVendor = project.vendor;
  const finalAppId =
    (typeof project.appId === 'string' ? project.appId.trim() : '') ||
    `org.${sanitizedName}.browser`;
  const finalBinaryName =
    (typeof project.binaryName === 'string' ? project.binaryName.trim() : '') || sanitizedName;
  const finalFirefoxVersion =
    (typeof project.firefoxVersion === 'string' ? project.firefoxVersion.trim() : '') || '140.0esr';

  if (!isValidAppId(finalAppId)) {
    throw new InvalidArgumentError(`Derived appId "${finalAppId}" is invalid.`, 'appId');
  }
  if (!isValidFirefoxVersion(finalFirefoxVersion)) {
    throw new InvalidArgumentError(
      `Default Firefox version "${finalFirefoxVersion}" is invalid.`,
      'firefoxVersion'
    );
  }

  return {
    finalName,
    finalVendor,
    finalAppId,
    finalBinaryName,
    finalFirefoxVersion,
    finalProduct:
      (typeof project.product === 'string'
        ? resolveFirefoxProduct(project.product, 'product')
        : undefined) ??
      inferProductFromVersion(finalFirefoxVersion) ??
      'firefox',
    finalLicense: resolveProjectLicense(project.license, 'license'),
  };
}

/** Resolves setup inputs from CLI flags and optional interactive prompts. */
export async function resolveSetupInputs(
  options: SetupOptions,
  isInteractive: boolean
): Promise<ResolvedSetupInputs> {
  if (
    options.name &&
    options.vendor &&
    options.appId &&
    options.binaryName &&
    options.firefoxVersion
  ) {
    return {
      finalName: options.name,
      finalVendor: options.vendor,
      finalAppId: options.appId,
      finalBinaryName: options.binaryName,
      finalFirefoxVersion: options.firefoxVersion,
      finalProduct: options.product ?? inferProductFromVersion(options.firefoxVersion) ?? 'firefox',
      finalLicense: options.license ?? 'EUPL-1.2',
    };
  }

  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Missing required options for non-interactive mode. Required: --name, --vendor, --app-id, --binary-name, --firefox-version'
    );
  }

  return promptSetupInputs(options);
}

/** Builds the persisted FireForge config from resolved setup inputs. */
export function buildSetupConfig(inputs: ResolvedSetupInputs): FireForgeConfig {
  return {
    name: inputs.finalName,
    vendor: inputs.finalVendor,
    appId: inputs.finalAppId,
    binaryName: inputs.finalBinaryName,
    license: inputs.finalLicense,
    firefox: {
      version: inputs.finalFirefoxVersion,
      product: inputs.finalProduct,
    },
    build: {
      jobs: Math.max(1, cpus().length),
    },
  };
}

/** Writes the initial project files produced by the setup workflow. */
export async function writeSetupProjectFiles(
  projectRoot: string,
  config: FireForgeConfig
): Promise<void> {
  const paths = getProjectPaths(projectRoot);

  await ensureDir(paths.patches);
  await ensureDir(paths.configs);
  await ensureDir(paths.fireforgeDir);

  await writeConfig(projectRoot, config);

  const gitignorePath = join(projectRoot, '.gitignore');
  const requiredIgnores = ['node_modules/', 'dist/', 'engine/', '.fireforge/'];

  if (await pathExists(gitignorePath)) {
    const existingContent = await readText(gitignorePath);
    const lines = existingContent.split('\n').map((line) => line.trim());
    const missing = requiredIgnores.filter((item) => {
      const withoutSlash = item.endsWith('/') ? item.slice(0, -1) : item;
      return !lines.includes(item) && !lines.includes(withoutSlash);
    });

    if (missing.length > 0) {
      const toAppend = (existingContent.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n';
      await writeText(gitignorePath, existingContent + toAppend);
    }
  } else {
    await writeText(gitignorePath, requiredIgnores.join('\n') + '\n');
  }

  const rootPackageJsonPath = join(projectRoot, 'package.json');
  if (!(await pathExists(rootPackageJsonPath))) {
    const rootPackageJson = {
      private: true,
      license: config.license,
    };
    await writeText(rootPackageJsonPath, JSON.stringify(rootPackageJson, null, 2) + '\n');
  }

  const templatesDir = getTemplatesDir();
  if (config.license !== undefined) {
    const licenseTemplatePath = join(templatesDir, 'licenses', `${config.license}.md`);
    if (await pathExists(licenseTemplatePath)) {
      const licenseText = renderLicenseTemplate(
        config.license,
        await readText(licenseTemplatePath),
        config.vendor
      );
      await writeText(join(projectRoot, 'LICENSE'), licenseText);
    }
  }

  const configsTemplateDir = join(templatesDir, 'configs');
  if (!(await pathExists(configsTemplateDir))) {
    return;
  }

  const configFiles = [
    'common.mozconfig',
    'darwin.mozconfig',
    'linux.mozconfig',
    'win32.mozconfig',
  ];

  for (const file of configFiles) {
    const srcPath = join(configsTemplateDir, file);
    const destPath = join(paths.configs, file);

    if (!(await pathExists(srcPath))) {
      continue;
    }

    const content = (await readText(srcPath))
      .replace(/\$\{name\}/g, config.name)
      .replace(/\$\{vendor\}/g, config.vendor)
      .replace(/\$\{appId\}/g, config.appId)
      .replace(/\$\{binaryName\}/g, config.binaryName);

    await writeText(destPath, content);
  }
}
