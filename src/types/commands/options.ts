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
  /**
   * Print the computed export plan without writing anything. With
   * `--supersede`, the dry-run output includes which existing patches would
   * be superseded and which files caused the coverage.
   */
  dryRun?: boolean;
  /** Place the new patch at a specific ordinal, shifting subsequent patches. */
  order?: number;
  /** Place the new patch immediately before the named patch. */
  before?: string;
  /** Place the new patch immediately after the named patch. */
  after?: string;
  /**
   * Skip the confirmation prompt when placement forces a renumber of more
   * than one existing patch. Required for non-TTY runs that use placement
   * flags.
   */
  yes?: boolean;
  /** Bypass cross-patch lint refusal for projected placement state. */
  forceUnsafe?: boolean;
  /** Exclude furnace-managed file paths from the export. */
  excludeFurnace?: boolean;
}

/**
 * Options for the reset command.
 */
export interface ResetOptions {
  /** Skip confirmation prompt */
  yes?: boolean;
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
  yes?: boolean;
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
  /**
   * Apply patches only up to and including this patch (by name or ordinal).
   * Subsequent patches are left unapplied. Useful for bisection and curated
   * rebuild workflows.
   */
  until?: string;
  /** Preview which patches would be applied without modifying the engine */
  dryRun?: boolean;
}

/**
 * Options for the re-export command.
 */
export interface ReExportOptions {
  /** Re-export all patches */
  all?: boolean;
  /** Scan directories for new/removed files and update filesAffected */
  scan?: boolean;
  /**
   * Restrict the re-exported patch's filesAffected to this explicit list.
   * Files currently in the patch but not in this list are dropped (shrink);
   * files in this list but not currently in the patch are added. Mutually
   * exclusive with `--scan` and `--all`; applies to a single target patch
   * at a time.
   */
  files?: string[];
  /** Show what would change without writing */
  dryRun?: boolean;
  /** Skip patch lint checks (downgrade errors to warnings) */
  skipLint?: boolean;
  /** Skip confirmation prompt on shrink (required for non-TTY) */
  yes?: boolean;
  /** Bypass cross-patch lint refusal on projected shrink state */
  forceUnsafe?: boolean;
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
  yes?: boolean;
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
  /** Proceed despite baseVersion drift (stale overrides) */
  force?: boolean;
  /** Watch component directories and re-apply on changes */
  watch?: boolean;
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
  /** Proceed despite baseVersion drift (stale overrides) */
  force?: boolean;
  /** Skip the validation step (apply only, no accessibility/compatibility checks) */
  skipValidate?: boolean;
}

/**
 * Options for the furnace refresh command.
 */
export interface FurnaceRefreshOptions {
  /** Show what would change without modifying files */
  dryRun?: boolean;
  /** Refresh all overrides in a single batch */
  all?: boolean;
  /** Conflict resolution strategy for automated use (ours = keep local, theirs = accept upstream) */
  strategy?: 'ours' | 'theirs';
  /** Reset the override's baseline to the current engine HEAD, skipping three-way merge */
  resetBase?: boolean;
}

/**
 * Options for the furnace sync command.
 */
export interface FurnaceSyncOptions {
  /** Show what would change without modifying files */
  dryRun?: boolean;
  /** Conflict resolution strategy for three-way merge (ours = keep local, theirs = accept upstream) */
  strategy?: 'ours' | 'theirs';
}

/**
 * Options for the furnace validate command.
 */
export interface FurnaceValidateOptions {
  /** Auto-fix registration issues (missing jar.mn entries, customElements.js registration) */
  fix?: boolean;
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
  yes?: boolean;
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
 * Options for the patch delete command.
 */
export interface PatchDeleteOptions {
  /** Skip confirmation prompt; required for non-TTY runs. */
  yes?: boolean;
  /** Print what would happen without writing anything. */
  dryRun?: boolean;
  /** Bypass the hard refusal when later patches depend on the target. */
  forceUnsafe?: boolean;
}

/**
 * Options for the patch reorder command.
 */
export interface PatchReorderOptions {
  to?: number;
  before?: string;
  after?: string;
  yes?: boolean;
  dryRun?: boolean;
  forceUnsafe?: boolean;
}

/**
 * Options for the patch compact command.
 */
export interface PatchCompactOptions {
  /** Skip confirmation prompt; required for non-TTY runs. */
  yes?: boolean;
  /** Print what would happen without writing anything. */
  dryRun?: boolean;
}

/**
 * Options for the status command.
 */
export interface StatusOptions {
  raw?: boolean;
  unmanaged?: boolean;
  /**
   * Render a flat file→owning-patch ownership table instead of the three-
   * bucket classification. Sources the path list from the manifest's
   * `filesAffected` per patch and flags any path claimed by more than one
   * patch as an ownership conflict.
   */
  ownership?: boolean;
  /** Output machine-readable JSON instead of human-readable text. */
  json?: boolean;
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
  /**
   * Opt-in repair path for furnace-specific checks. When true, doctor will:
   * - clear stale `.fireforge/furnace-state.json` entries whose component is
   *   no longer in `furnace.json`,
   * - run `applyAllComponents` to reconcile any engine drift,
   * - clear the `pendingRepair` marker on success.
   * Mirrors `repairPatchesManifest` in that the repair is only attempted when
   * the caller explicitly asks for it, so a read-only `doctor` run stays cheap
   * and side-effect-free.
   */
  repairFurnace?: boolean;
}

/**
 * Global CLI options available to all commands.
 */
export interface GlobalOptions {
  /** Enable verbose/debug output */
  verbose?: boolean;
}
