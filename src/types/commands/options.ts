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
  /**
   * When a mozinfo mismatch is detected that looks like a safe path
   * relocation (same structure, different prefix), patch mozinfo paths
   * in place and run `mach configure` rather than aborting with a
   * full-rebuild instruction. Falls back to the original abort message
   * for any mismatch the rewriter cannot prove safe.
   */
  rewriteMozinfo?: boolean;
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
  /**
   * Acknowledge that the export will create cross-patch ownership overlap
   * with existing non-superseded patches. Without this flag, `export`
   * refuses when one or more `filesAffected` are already claimed by
   * another patch, because the resulting queue fails `verify` immediately.
   */
  allowOverlap?: boolean;
  /**
   * Force a tier override on the new patch's `PatchMetadata.tier`. Only
   * `"branding"` is currently recognised — Commander rejects other values
   * before the handler runs. Use when a branding patch legitimately
   * touches a non-allowlisted sibling that `isBrandingOnlyPatch` cannot
   * reach (a fork-specific theme override under `browser/themes/<name>/`,
   * a vendor-specific icon resource, etc.).
   */
  tier?: 'branding';
  /**
   * Lint check IDs to suppress on this patch. Writes to
   * `PatchMetadata.lintIgnore`. Repeatable on the CLI; each occurrence
   * appends to the list. Useful when a patch is advisory-noisy by nature
   * (a cohesive branding bundle, an auto-generated manifest) and a
   * specific check does not apply, but `--skip-lint` is too coarse a
   * hammer.
   */
  lintIgnore?: string[];
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
  /**
   * After every selected patch re-exports cleanly, stamp each re-exported
   * patch's `sourceEsrVersion` in `patches.json` to the current
   * `firefox.version` from `fireforge.json`. Opt-in because the default
   * contract of `re-export` is "refresh the patch body and filesAffected";
   * version stamping is normally a `rebase` responsibility. Use this when
   * re-exporting after a manual Firefox bump that did not go through
   * `rebase`.
   */
  stamp?: boolean;
  /**
   * Force a tier override on the selected patch(es). Only `"branding"` is
   * currently recognised. Mutually exclusive with `--all` — mass tier
   * changes are virtually always footguns, since different patches in
   * the queue have different shapes.
   */
  tier?: 'branding';
  /**
   * Lint check IDs to suppress, **appended** (union) to the patch's
   * existing `lintIgnore` list. De-duplicated. Mutually exclusive with
   * `--all`. To remove an entry or clear the list entirely, use the
   * `fireforge patch lint-ignore` subcommand (which has explicit
   * `--add` / `--remove` / `--clear` modes); re-export's append-only
   * semantics match the operator's most common intent ("I want this
   * patch to also suppress X").
   */
  lintIgnore?: string[];
}

/**
 * Options for the `fireforge patch tier` subcommand. Sets or clears the
 * `PatchMetadata.tier` field on a single patch without rewriting the
 * `.patch` file body — the manifest is the only thing that changes.
 */
export interface PatchTierOptions {
  /** Force the named tier on the patch. Only `"branding"` is recognised. */
  tier?: 'branding';
  /** Remove the `tier` override entirely, restoring auto-detection. */
  clear?: boolean;
  /** Print the planned change without writing. */
  dryRun?: boolean;
  /** Skip the confirmation prompt (required for non-TTY). */
  yes?: boolean;
}

/**
 * Options for the `fireforge patch lint-ignore` subcommand. Modes are
 * mutually exclusive — exactly one of `add`, `remove`, or `clear` must
 * be set per invocation.
 */
export interface PatchLintIgnoreOptions {
  /** Lint check IDs to add to the patch's `lintIgnore` list (union, de-duped). */
  add?: string[];
  /** Lint check IDs to remove from the patch's `lintIgnore` list. */
  remove?: string[];
  /** Drop the `lintIgnore` field entirely. */
  clear?: boolean;
  /** Print the planned change without writing. */
  dryRun?: boolean;
  /** Skip the confirmation prompt (required for non-TTY). */
  yes?: boolean;
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
  /**
   * Enable smoke-run mode. Launches the browser, streams the console,
   * sends SIGTERM to the whole process group after `smokeExit` seconds,
   * and applies the smoke exit contract:
   *  - `0` — clean window (no unallowed error lines).
   *  - `ExitCode.SMOKE_EXIT_FAILURE` (12) — one or more console lines
   *    matched the error heuristic and were not covered by the allowlist.
   *  - `ExitCode.SMOKE_LAUNCH_FAILURE` (13) — the browser exited with a
   *    non-clean status before the smoke window elapsed (launch-side
   *    failure we cannot observe as a console line — crash before console
   *    wiring, missing profile, etc.).
   *
   * POSIX only (process-group semantics do not map cleanly onto Windows);
   * `runSmokeExit` rejects the flag up front on `win32`.
   */
  smokeExit?: number;
  /**
   * Repeatable regex patterns that mark a matching console line as
   * benign. Matches are still counted for the summary but do not drive
   * the smoke-run exit code.
   */
  consoleAllow?: string[];
  /**
   * Path to a newline-delimited allowlist regex file. Blank lines and
   * `#` comments are ignored; each remaining line is compiled as a
   * regex and appended to the active allowlist.
   */
  consoleAllowFile?: string;
  /**
   * Mirror the captured console output to this file path so agents can
   * inspect the raw stream after smoke-exit returns.
   */
  captureConsole?: string;
}

/**
 * Options for the test command.
 */
export interface TestOptions {
  /** Run tests in headless mode */
  headless?: boolean;
  /** Run incremental UI build before testing */
  build?: boolean;
  /**
   * Run a marionette preflight before tests. Reports PASS/FAIL in under a
   * minute. When test paths are supplied, a FAIL aborts before mach test is
   * spawned. When no paths are supplied, runs the preflight only and exits.
   */
  doctor?: boolean;
  /**
   * Extra arguments forwarded verbatim to `mach test` (repeatable). Escape
   * valve for upstream xpcshell/mochitest flags that FireForge does not
   * model directly. Order relative to other flags is preserved; passthrough
   * values appear after `--headless` if both are set.
   */
  machArg?: string[];
  /**
   * Override the Marionette control port (default 2828) used by the
   * stale-browser probe, the `--doctor` preflight, and the auto-forwarded
   * `--setpref=marionette.port=<n>` arg passed to mach (omitted when mach
   * args explicitly set `--flavor=xpcshell` / `xpcshell-tests`). Set this
   * when a stale process holds the default port and `kill` is not an option,
   * or when a CI runner reserves a different port for parallel test runs.
   */
  marionettePort?: number;
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
  /**
   * Scaffold an xpcshell test harness (headless, no tabbrowser) instead of
   * browser-chrome. Required for forks without a `tabbrowser` (storage-only
   * code, observer-driven modules). Implies `withTests` when set. Writes an
   * `xpcshell.toml` + `test_<name>.js` under
   * `engine/browser/base/content/test/<binary-name>-xpcshell/` and leaves
   * moz.build registration to the operator (add the directory to
   * `XPCSHELL_TESTS_MANIFESTS`).
   */
  xpcshell?: boolean;
  /**
   * Test harness style to scaffold when `--with-tests` is set.
   *
   * - `mochikit` (default when `--with-tests` is set alone) — a MochiKit
   *   test at `engine/toolkit/content/tests/widgets/test_<tag>.html` that
   *   loads the component module directly via `chrome://global/` and
   *   asserts against `customElements`. Runs today on forks whose
   *   top-level chrome document (e.g. `mybrowser.xhtml`) lacks a
   *   `tabbrowser`, because it doesn't go through `URILoadingHelper`.
   * - `browser-chrome` — today's browser-mochitest scaffold, requires a
   *   working tabbrowser. Use for components that talk to the browser
   *   window or open URLs.
   * - `xpcshell` — equivalent to setting `--xpcshell`; headless, storage-only.
   */
  testStyle?: 'mochikit' | 'browser-chrome' | 'xpcshell';
  /** Stock component tag names composed internally by this component */
  compose?: string[];
  /**
   * Participate in a pre-existing feature-scoped Fluent bundle at this
   * path (as used by `insertFTLIfNeeded`, e.g. `browser/mybrowser-dock.ftl`)
   * instead of scaffolding a per-component `.ftl`. Implies `localized`.
   * Persists onto the furnace.json entry so validation and apply skip the
   * per-component paths.
   */
  sharedFtl?: string;
  /**
   * Show the planned file set and furnace.json changes without writing
   * anything. All validation that does not require disk writes (tag name
   * shape, name conflicts, engine pre-existence, `--compose` targets, cycle
   * detection, prefix warning) runs before the plan is emitted, so a
   * dry-run faithfully previews the real command's outcome.
   */
  dryRun?: boolean;
  /**
   * Bypass the configured `componentPrefix` check for the supplied name.
   * Without this flag, a name that does not start with the prefix is
   * rejected before any files are written, so a prefix-mismatched
   * component cannot leave behind a half-scaffolded state. Pass this
   * flag only when you know the prefix mismatch is intentional — e.g.
   * creating an experimental component whose name intentionally breaks
   * the fork's convention.
   */
  allowPrefixMismatch?: boolean;
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
  /**
   * Chrome document the DOM fragment's `#include` is inserted into, relative
   * to engine/. Defaults to the first entry of
   * `furnace.json.tokenHostDocuments` when set, otherwise
   * `browser/base/content/browser.xhtml`.
   */
  target?: string;
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
 * Options for the `fireforge patch rename` subcommand. Updates the
 * patch's filename, manifest `name`, and (optionally) `description`
 * atomically without rewriting the `.patch` file body. Companion to
 * `re-export --files` for the case where the body is already correct
 * but the patch's identity (filename + description) describes a
 * pre-shrink scope; before this verb existed the only workaround was
 * `delete` + re-export, which briefly dropped the patch from the queue.
 */
export interface PatchRenameOptions {
  /**
   * New human-readable name. Sanitised the same way `export --name`
   * sanitises into the filename slug (lowercase, non-alphanumerics
   * collapsed to `-`, length-capped). The patch's `name` field stores
   * the raw value; the filename uses the sanitised slug.
   */
  to?: string;
  /**
   * Replacement description. Omit to leave the description unchanged
   * (intentional — operators frequently want to relabel the slug
   * without touching the description).
   */
  description?: string;
  /** Print the planned change without writing. */
  dryRun?: boolean;
  /** Skip the confirmation prompt (required for non-TTY). */
  yes?: boolean;
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
