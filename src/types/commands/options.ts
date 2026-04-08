// SPDX-License-Identifier: EUPL-1.2
/**
 * Command option types for CLI commands.
 */

import type { FirefoxProduct, ProjectLicense } from '../config.js';
import type { PatchCategory } from './patches.js';

/**
 * Options for the setup command.
 */
export interface SetupOptions {
  /** Browser name */
  name?: string;
  /** Vendor/company name */
  vendor?: string;
  /** Application ID (reverse-domain format) */
  appId?: string;
  /** Binary name (executable name) */
  binaryName?: string;
  /** Firefox version to base on */
  firefoxVersion?: string;
  /** Firefox product type (firefox, firefox-esr, firefox-beta) */
  product?: FirefoxProduct;
  /** Overwrite existing configuration without prompting */
  force?: boolean;
  /** Project license SPDX identifier */
  license?: ProjectLicense;
}

/**
 * Options for the download command.
 */
export interface DownloadOptions {
  /** Force re-download, deleting existing engine/ */
  force?: boolean;
}

/**
 * Options for the build command.
 */
export interface BuildOptions {
  /** Fast UI-only rebuild */
  ui?: boolean;
  /** Number of parallel jobs */
  jobs?: number;
  /** Brand to build (stable, esr, etc.) */
  brand?: string;
}

/**
 * Options for the export command.
 */
export interface ExportOptions {
  /** Name/description for the patch */
  name?: string;
  /** Category classification */
  category?: PatchCategory;
  /** Detailed description of what the patch does */
  description?: string;
  /** Allow superseding multiple existing patches without confirmation */
  supersede?: boolean;
  /** Skip patch lint checks (downgrade errors to warnings) */
  skipLint?: boolean;
}

/**
 * Options for the reset command.
 */
export interface ResetOptions {
  /** Skip confirmation prompt */
  force?: boolean;
  /** Show what would be reset without doing it */
  dryRun?: boolean;
}

/**
 * Options for the discard command.
 */
export interface DiscardOptions {
  /** Show what would be discarded without doing it */
  dryRun?: boolean;
  /** Skip confirmation prompt */
  force?: boolean;
}

/**
 * Options for the package command.
 */
export interface PackageOptions {
  /** Brand to package */
  brand?: string;
}

/**
 * Options for the import command.
 */
export interface ImportOptions {
  /** Specific patches to apply (by name) */
  patches?: string[];
  /** Continue applying patches even if one fails */
  continue?: boolean;
  /** Force import even when engine HEAD has drifted from base commit */
  force?: boolean;
}

/**
 * Options for the re-export command.
 */
export interface ReExportOptions {
  /** Re-export all patches */
  all?: boolean;
  /** Scan directories for new/removed files and update filesAffected */
  scan?: boolean;
  /** Show what would change without writing */
  dryRun?: boolean;
  /** Skip patch lint checks (downgrade errors to warnings) */
  skipLint?: boolean;
}

/**
 * Options for the rebase command.
 */
export interface RebaseOptions {
  /** Resume a previously interrupted rebase session */
  continue?: boolean;
  /** Cancel the current rebase session and restore engine */
  abort?: boolean;
  /** Show what would happen without modifying anything */
  dryRun?: boolean;
  /** Maximum fuzz factor for git apply (default 3) */
  maxFuzz?: number;
  /** Skip dirty-tree confirmation prompt */
  force?: boolean;
}

/**
 * Options for the run command.
 */
export interface RunOptions {
  /** Additional arguments to pass to the browser */
  args?: string[];
}

/**
 * Options for the test command.
 */
export interface TestOptions {
  /** Run tests in headless mode */
  headless?: boolean;
  /** Run incremental UI build before testing */
  build?: boolean;
}

/**
 * Options for the furnace apply command.
 */
export interface FurnaceApplyOptions {
  /** Show what would be changed without writing */
  dryRun?: boolean;
}

/**
 * Options for the furnace preview command.
 */
export interface FurnacePreviewOptions {
  /** Force reinstall Storybook dependencies */
  install?: boolean;
}

/**
 * Options for the furnace deploy command.
 */
export interface FurnaceDeployOptions {
  /** Show what would be changed without writing */
  dryRun?: boolean;
}

/**
 * Options for the furnace override command.
 */
export interface FurnaceOverrideOptions {
  /** Override type: css-only or full */
  type?: 'css-only' | 'full';
  /** Description of the override */
  description?: string;
}

/**
 * Options for the furnace remove command.
 */
export interface FurnaceRemoveOptions {
  /** Skip confirmation prompt */
  force?: boolean;
}

/**
 * Options for the furnace create command.
 */
export interface FurnaceCreateOptions {
  /** Component description */
  description?: string;
  /** Include Fluent l10n support */
  localized?: boolean;
  /** Register in customElements.js (default: true) */
  register?: boolean;
  /** Scaffold Mochitest directory and register in moz.build */
  withTests?: boolean;
  /** Stock component tag names composed internally by this component */
  compose?: string[];
}

/**
 * Options for the wire command.
 */
export interface WireOptions {
  init?: string;
  destroy?: string;
  dom?: string;
  dryRun?: boolean;
  after?: string;
  subscriptDir?: string;
}

/**
 * Options for the register command.
 */
export interface RegisterOptions {
  dryRun?: boolean;
  after?: string;
}

/**
 * Options for the status command.
 */
export interface StatusOptions {
  raw?: boolean;
  unmanaged?: boolean;
}

/**
 * Options for the token add command.
 */
export interface TokenAddOptions {
  category: string;
  mode: string;
  description?: string;
  darkValue?: string;
  dryRun?: boolean;
}

/**
 * Options for the doctor command.
 */
export interface DoctorOptions {
  repairPatchesManifest?: boolean;
}

/**
 * Global CLI options available to all commands.
 */
export interface GlobalOptions {
  /** Enable verbose/debug output */
  verbose?: boolean;
}
