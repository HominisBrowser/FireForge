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
  /** Firefox product type (firefox, firefox-esr, firefox-beta, firefox-devedition) */
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
 * Options for the source command.
 */
export interface SourceSetOptions {
  /** Firefox version to set */
  version: string;
  /** Firefox product type */
  product: FirefoxProduct;
  /** Optional pinned SHA-256 for the resolved source archive */
  sha256?: string;
  /** Clear any existing pinned SHA-256 */
  clearSha256?: boolean;
  /** Optional release-candidate build directory (e.g. "build2") */
  candidate?: string;
  /** Clear any existing release-candidate build directory */
  clearCandidate?: boolean;
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
  /**
   * Parsed `--wait-lock [seconds]` value (`true` for the bare flag, meaning
   * 60). Consumed at the CLI layer to bound the engine-session-lock wait;
   * the command implementation ignores it.
   */
  waitLock?: number | boolean;
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
  /** Place the new patch at this exact unused order without renumbering existing patches. */
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
   * Export the deployed engine copy even when the `components/` source
   * changed since the last furnace apply. Without this flag the export is
   * refused so a stale deployed copy cannot silently land in the patch.
   */
  allowStaleFurnace?: boolean;
  /**
   * Acknowledge that the export will create cross-patch ownership overlap
   * with existing non-superseded patches. Without this flag, `export`
   * refuses when one or more `filesAffected` are already claimed by
   * another patch, because the resulting queue fails `verify` immediately.
   */
  allowOverlap?: boolean;
  /**
   * Parsed `--wait-lock [seconds]` value (`true` for the bare flag, meaning
   * 60). Consumed at the CLI layer to bound the engine-session-lock wait;
   * the command implementation ignores it.
   */
  waitLock?: number | boolean;
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
  /**
   * Restore to pristine upstream (HEAD) instead of the patch-applied
   * baseline; deletes patch-created files (the pre-0.39.0 semantics —
   * FORGE F1).
   */
  toUpstream?: boolean;
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
   * Explicit engine-relative files to add while scanning. Unlike broad
   * `--scan`, this does not collect adjacent files from the same directory.
   * Requires `--scan` and exactly one target patch.
   */
  scanFiles?: string[];
  /**
   * Path to a JSON manifest containing bulk scan assignments:
   * `{ "assignments": [{ "patch": "<patch>", "files": ["path"] }] }`.
   * Requires `--scan`; mutually exclusive with positional patches, `--all`,
   * `--scan-file`, and `--files`.
   */
  scanFilesManifest?: string;
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
  /**
   * Explicitly allow `--files` to remove paths that are currently owned by
   * the patch. Without this acknowledgement, non-dry-run shrinks are refused
   * before the interactive/`--yes` confirmation path.
   */
  allowShrink?: boolean;
  /**
   * Export the deployed engine copy even when the `components/` source
   * changed since the last furnace apply. Without this flag the re-export
   * is refused so a stale deployed copy cannot silently land in the patch.
   */
  allowStaleFurnace?: boolean;
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
  /**
   * Parsed `--wait-lock [seconds]` value (`true` for the bare flag, meaning
   * 60). Consumed at the CLI layer to bound the engine-session-lock wait;
   * the command implementation ignores it.
   */
  waitLock?: number | boolean;
  /**
   * Refuse (non-zero exit, patch not written) a scan-less re-export when
   * unmanaged files exist adjacent to the patch's ownership, instead of
   * warning. Gate-driven workflows use this so a freshly created file
   * beside a patch's owned files cannot be silently left out of the
   * refreshed body. Only meaningful on the plain path — mutually
   * exclusive with `--scan` and `--files`, which set filesAffected
   * explicitly.
   */
  refuseAdjacentUnmanaged?: boolean;
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
 * Options for the `fireforge patch staged-dependency` subcommand. Modes are
 * mutually exclusive: add a declaration, remove one or more matching
 * declarations, or clear all staged dependencies from the patch.
 */
export interface PatchStagedDependencyOptions {
  /** Add a staged dependency declaration. */
  add?: boolean;
  /** Remove matching staged dependency declarations. */
  remove?: boolean;
  /** Drop the stagedDependencies field entirely. */
  clear?: boolean;
  /**
   * Declaration shape: `import` (forward import, the default when unset) or
   * `registration` (jar.mn packaging line, customElements or actor
   * registration). Registration entries use `line` instead of `specifier`.
   */
  kind?: string;
  /** Declaring file path relative to engine/. */
  file?: string;
  /** Exact import specifier as it appears in source (`kind: import`). */
  specifier?: string;
  /**
   * Registration/packaging line as the patch adds it, compared
   * whitespace-trimmed (`kind: registration`).
   */
  line?: string;
  /** Later-created file path relative to engine/. */
  creates?: string;
  /** Optional exact patch filename expected to create `creates`. */
  owner?: string;
  /** Optional human-readable rationale stored with the declaration. */
  reason?: string;
  /** Print the planned change without writing. */
  dryRun?: boolean;
  /** Skip the confirmation prompt (required for non-TTY). */
  yes?: boolean;
}

/**
 * Options for the `patch split` command.
 */
export interface PatchSplitOptions {
  /** Files to move out of the source patch (engine-relative). */
  files: string[];
  /** Name for the new patch (used in its filename slug). */
  name: string;
  /** Category for the new patch; defaults to the source patch's category. */
  category?: string;
  /** Description for the new patch. */
  description?: string;
  /** Exact sparse order for the new patch (mutually exclusive with before/after). */
  order?: number;
  /** Place the new patch before this patch identifier. */
  before?: string;
  /** Place the new patch after this patch identifier (default: the source). */
  after?: string;
  /** Preview without writing. */
  dryRun?: boolean;
  /** Skip interactive confirmation (required for non-TTY). */
  yes?: boolean;
  /** Bypass projected-lint refusals. */
  forceUnsafe?: boolean;
  /** Skip per-patch lint of the projected bodies. */
  skipLint?: boolean;
}

/**
 * Options for the `fireforge patch move-files` subcommand. Without
 * `--create` it is preview-only: it validates an ownership transfer and
 * prints the explicit `re-export --files` commands needed to perform it.
 * With `--create --order <n>` the target patch is created at that order
 * and the files move into it as one split-style transaction.
 */
export interface PatchMoveFilesOptions {
  /** File paths relative to engine/ to move from the source patch to the target patch. */
  file?: string[];
  /** Create the target patch (transactional bootstrap of a split). Requires `order`. */
  create?: boolean;
  /** Exact sparse order for the created patch. Only valid with `create`. */
  order?: number;
  /** Category for the created patch; defaults to the source patch's. */
  category?: string;
  /** Description for the created patch. */
  description?: string;
  /** Preview the create+move without writing. */
  dryRun?: boolean;
  /** Skip interactive confirmation (required for non-TTY). */
  yes?: boolean;
  /** Bypass projected-lint refusals. */
  forceUnsafe?: boolean;
  /** Skip per-patch lint of the projected bodies. */
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
  /**
   * Launch the browser with `--headless` (forwarded to the binary via
   * `mach run`). Primarily for smoke mode on shared desktops: a headed
   * smoke window absorbs live keyboard/mouse input, and the resulting
   * console errors contaminate the capture and can fail the run.
   */
  headless?: boolean;
}

/**
 * Options for the test command.
 */
export interface TestOptions {
  /** Run tests in headless mode */
  headless?: boolean;
  /** Run incremental UI build before testing */
  build?: boolean;
  /** Forward mach's pathless auto-selection mode. Valid only with no explicit paths. */
  auto?: boolean;
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
   * stale-browser probe, the `--doctor` preflight, and (unless mach args set
   * `--flavor=xpcshell` / `xpcshell-tests`) auto-forwarded mach flags:
   * `--setpref=marionette.port=<n>` for the browser listener and
   * `--marionette=127.0.0.1:<n>` for the mochitest harness client. Omits the
   * client flag when `--mach-arg` already passes `--marionette`. Set when a
   * stale process holds the default port or CI uses another port.
   */
  marionettePort?: number;
  /** Kill a recognized stale browser process holding the Marionette port, then continue. */
  killStaleMarionette?: boolean;
  /** Permit tests against packageable engine edits newer than the last successful build. */
  allowStaleBuild?: boolean;
  /**
   * Permit tests despite `components.conf` changes that only a full
   * `fireforge build` compiles into the StaticComponents table — the
   * packaged child process will resolve the OLD table. For operators who
   * rebuilt out-of-band and accept the risk; distinct from
   * `allowStaleBuild`, which only accepts stale packaged content.
   */
  allowStaleComponents?: boolean;
  /** Run the configured short harness canary. `true` means use `fireforge.json`'s test.canaryPath. */
  canary?: string | boolean;
  /**
   * Retry budget for recognized harness crashes (resource-monitor
   * tracebacks, pre-test no-output hangs, post-green shutdown re-entry).
   * 0 disables retries. Defaults to {@link DEFAULT_HARNESS_RETRIES} at the
   * command layer.
   */
  harnessRetries?: number;
  /**
   * Force dispatch through the generic `mach test` command instead of the
   * suite-specific `mach xpcshell-test` / `mach mochitest` commands a
   * single-suite run auto-selects. Escape hatch for the rare case where a
   * suite-specific command misbehaves; on a healthy host the generic command
   * is equivalent. The default (auto suite dispatch) skips the mozlog
   * resource monitor that crashes `mach test` on a broken host (E1).
   */
  genericMachTest?: boolean;
  /**
   * Commander negation flag for `--no-shard`. When false, multiple test
   * paths run in one combined mach invocation; by default they shard into
   * sequential single-file harness runs with an aggregate report.
   */
  shard?: boolean;
  /**
   * Project-relative (or absolute) artifact path published to the harness
   * run as `<BINARYNAME>_PERF_SAMPLE_JSON`, for downstream perf-budget
   * checkers that consume a sample artifact after the run.
   */
  perfSamples?: string;
  /**
   * Parsed `--wait-lock [seconds]` value (`true` for the bare flag, meaning
   * 60). Consumed at the CLI layer to bound the engine-session-lock wait;
   * the command implementation ignores it.
   */
  waitLock?: number | boolean;
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
  /**
   * Engine-relative directory the test scaffold writes into, instead of
   * the default `browser/base/content/test/<binaryName>/` (browser-chrome)
   * or `browser/base/content/test/<binaryName>-xpcshell/<component>/`
   * (xpcshell). Must stay under `browser/base/content/test/` so the
   * manifest registration keeps working. Not supported for
   * `--test-style=mochikit` (that harness lives in the upstream
   * toolkit/content/tests/widgets tree).
   */
  testDir?: string;
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
   * - `browser-chrome` (default when `--with-tests` is set without
   *   `--test-style`) — browser mochitest scaffold; requires a working
   *   `tabbrowser`. Prefer this for interactive chrome/widget coverage
   *   (including on macOS).
   * - `mochikit` — opt-in MochiKit test at
   *   `engine/toolkit/content/tests/widgets/test_<tag>.html` that loads
   *   the component via `chrome://global/`. Use when the top-level chrome
   *   document lacks a `tabbrowser`; on macOS the toolkit mochitest-chrome
   *   flavor can be unreliable (long idle timeout).
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
  /** Scaffold a missing manifest (moz.build / xpcshell.toml) and wire the parent chain. */
  createManifest?: boolean;
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
  /** Bypass force-mode patchPolicy refusals. */
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
  /** Bypass force-mode patchPolicy refusals. */
  forceUnsafe?: boolean;
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
  /**
   * Print the recorded test-packaging coverage of the last build baseline
   * (scope, timestamp, recording invocation) and exit. Read-only — the
   * counterpart to the out-of-coverage test refusal (FORGE F11).
   */
  testCoverage?: boolean;
  /** Output machine-readable JSON instead of human-readable text. */
  json?: boolean;
  /**
   * Exit non-zero when any classification in the fail policy is
   * non-empty (default policy: unmanaged, patch-owned-drift, conflict).
   * Composes with the default view and `--json`; refused alongside
   * `--raw`/`--unmanaged`/`--ownership`/`--test-coverage` (FORGE G1).
   */
  check?: boolean;
  /**
   * Comma-separated classification list replacing the default `--check`
   * policy. Implies `--check`. Unknown values refuse, naming the valid
   * classification set.
   */
  failOn?: string;
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
  /** Declare the category banner in the tokens CSS when it does not exist yet. */
  createCategory?: boolean;
  /**
   * Attribute selector fragment (e.g. `[data-skin=precision]` or
   * `[data-private]`) routing the declaration into a `:root<variant>` block.
   */
  variant?: string;
}

/**
 * Options for the doctor command.
 */
export interface DoctorOptions {
  repairPatchesManifest?: boolean;
  /**
   * Clear a stale `pendingResolution` marker, but only after the same
   * read-only queue health checks used by `fireforge verify` report no
   * error-severity findings.
   */
  clearResolution?: boolean;
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
  /** Run extra post-rebase checks for common Firefox registration surfaces. */
  postRebaseAudit?: boolean;
}

/**
 * Global CLI options available to all commands.
 */
export interface GlobalOptions {
  /** Enable verbose/debug output */
  verbose?: boolean;
}

/** Options controlling how the lint command filters and tags its output. */
export interface LintCommandOptions {
  /**
   * When set, tag each issue as `introduced` or `cumulative` based on
   * whether its file changed since this git revision (e.g. `HEAD`, a
   * branch name, or a SHA). Issues are not filtered — the full set still
   * prints — but a diff-scoped summary makes it trivial to see which
   * errors the current task introduced.
   */
  since?: string;
  /**
   * When set together with {@link since}, scope the exit code to issues
   * tagged `introduced`. Cumulative pre-existing errors still print (so
   * the operator can still see the full queue state) but do not fail
   * lint. Motivating case: a branch whose diff is clean but whose repo
   * already carries unrelated `raw-color` / license-header errors from
   * older patches. Without this flag, CI treats the clean branch as
   * failing; with it, a branch "breaks the build" only when its own diff
   * introduced a new error.
   *
   * Requires {@link since}: without a revision to diff against there is
   * no distinction between introduced and cumulative, so the flag is
   * rejected up-front rather than silently ignored.
   */
  onlyIntroduced?: boolean;
  /**
   * Lint each patch in the queue as its own isolated diff, rather than
   * the aggregate `git diff HEAD` across all applied patches.
   *
   * Motivating case: running `fireforge lint` (no args) on a repo where
   * `fireforge import` or `fireforge rebase` has just applied the full
   * patch queue produces an aggregate diff (every patch's changes
   * summed). The patch-size advisory rules (`large-patch-lines`,
   * `large-patch-files`) then fire against the sum — e.g. "Patch is
   * 37529 lines" on a queue of 22 individually-fine patches — which
   * reads as a task-specific regression when it is really an artefact
   * of the aggregation. `--per-patch` rescopes the diff to each patch's
   * own `filesAffected`, honours the patch's own `lintIgnore`, and runs
   * the cross-patch rules once over the whole queue so queue-level
   * findings (duplicate creations, forward imports) still surface.
   *
   * Positional file arguments change meaning under this flag: they are
   * PATCH selectors resolved like {@link patches} entries, not engine
   * file paths (FORGE G14).
   */
  perPatch?: boolean;
  /**
   * Restrict `--per-patch` to a named subset of the queue (by filename,
   * filename ± `.patch`, or manifest `name`). Lets a change that touches a
   * handful of patches run the per-patch gate over just those instead of
   * the full ~90-patch queue. Only valid with {@link perPatch}; queue-level
   * findings (policy, cross-patch) are scoped to files the subset touches.
   */
  patches?: string[];
  /**
   * Maximum warning count tolerated before lint exits non-zero. Mirrors
   * ESLint's `--max-warnings` shape for release gates that want advisory
   * findings to become blocking without changing default CLI behavior.
   */
  maxWarnings?: number;
  /**
   * Bypass per-patch lint cache reads and writes. Accepted in aggregate mode
   * for CLI consistency, but only `--per-patch` currently uses the cache.
   */
  noCache?: boolean;
  /**
   * With `--per-patch`, write a machine-readable JSON report (schemaVersion
   * 1: per-patch lineCount, filesAffected, tier, thresholds, issues, and
   * lintIgnore-suppressed issues) to this path (FORGE G9/G10). Requires
   * {@link perPatch}.
   */
  report?: string;
}
