// SPDX-License-Identifier: EUPL-1.2
/**
 * Component type classification.
 */
export type ComponentType = 'stock' | 'override' | 'custom';

/**
 * Override scope.
 */
export type OverrideType = 'css-only' | 'full';

/**
 * Info about a component discovered by scanning engine/.
 */
export interface ScannedComponent {
  /** Tag name (e.g., "moz-button") */
  tagName: string;
  /** Path relative to engine/ (e.g., "toolkit/content/widgets/moz-button") */
  sourcePath: string;
  /** Whether it has a .css file */
  hasCSS: boolean;
  /** Whether it has a .ftl localization file */
  hasFTL: boolean;
  /** Whether it's registered in customElements.js */
  isRegistered: boolean;
}

/**
 * Metadata for an override component in the workspace.
 */
export interface OverrideComponentConfig {
  /** Override scope */
  type: OverrideType;
  /** Description of the override */
  description: string;
  /** Path in engine/ where the original lives */
  basePath: string;
  /** Firefox version this override was based on */
  baseVersion: string;
  /** Git commit SHA the override was based on. Older overrides may lack this field. */
  baseCommit?: string;
}

/**
 * Metadata for a custom component in the workspace.
 */
export interface CustomComponentConfig {
  /** Description of the custom component */
  description: string;
  /** Target path in engine/ where this will be placed */
  targetPath: string;
  /** Whether to register in customElements.js */
  register: boolean;
  /** Whether this component uses Fluent l10n */
  localized: boolean;
  /** Stock component tag names composed internally by this component */
  composes?: string[];
  /**
   * Opts the component out of the `no-keyboard-handler` accessibility check
   * when it wraps a native-interactive inner element that is not tracked in
   * `composes` (for example a hand-authored `<button>` or a non-stock
   * `moz-*` widget). When `true`, the check is skipped even if the template
   * appears to attach `@click` to synthetic markup.
   *
   * Leave unset for the default behavior: the validator still silences the
   * check automatically when any entry in `composes` matches its native-
   * interactive allowlist (e.g. `moz-button`, `moz-toggle`). This flag is
   * only needed when `composes` does not capture the inner element.
   *
   * Operator-asserted: setting this to `true` does not re-check the
   * component, so it can be used to silence genuine findings. Prefer adding
   * the wrapped element to `composes` when that field applies.
   */
  keyboardCovered?: boolean;
  /**
   * Path of a pre-existing feature-scoped Fluent bundle this component
   * participates in, in the same form used by `insertFTLIfNeeded` (for
   * example `browser/mybrowser-dock.ftl`). When set:
   *
   *   - `furnace create --localized` does NOT scaffold a per-component
   *     `.ftl` stub — the component shares the feature bundle.
   *   - The generated `.mjs` calls `insertFTLIfNeeded("<sharedFtl>")` at
   *     the shared path instead of the per-component one.
   *   - `furnace validate`'s `missing-ftl` structural rule is skipped for
   *     the component (there is no `<tag>.ftl` to require).
   *   - `furnace apply` does NOT copy a per-component `.ftl` into the FTL
   *     tree nor register a new entry in the locale `jar.mn` — the shared
   *     file is owned by whoever authored the feature bundle.
   *
   * Requires `localized: true`. Mutually exclusive with the per-component
   * `.ftl` scaffold. Does NOT auto-migrate previous per-component FTL
   * state: flipping an existing component onto `sharedFtl` leaves the
   * prior per-component entry in the engine tree and the locale `jar.mn`
   * until explicitly cleaned up.
   */
  sharedFtl?: string;
}

/**
 * The furnace.json schema.
 */
export interface FurnaceConfig {
  /** Schema version */
  version: 1;
  /** Prefix for custom component tag names (default: "moz-") */
  componentPrefix: string;
  /** Optional CSS custom property prefix for design tokens (e.g. "--mybrowser-") */
  tokenPrefix?: string;
  /** Custom properties allowed even though they don't match tokenPrefix (e.g. ["--background-color-box"]) */
  tokenAllowlist?: string[];
  /**
   * CSS custom-property prefixes that identify upstream / platform
   * variables the fork does not own. `token coverage` counts matches
   * as `allowlisted` rather than `unknown` so a copied upstream
   * baseline doesn't drag fork-owned coverage percentages down.
   * Defaults to `['--moz-']` when unset. Pass an explicit empty array
   * to restore the pre-0.18.0 strict contract.
   */
  platformPrefixes?: string[];
  /**
   * Custom properties used as runtime state channels — written and read by the
   * component itself (e.g. per-frame camera/tile positions) rather than
   * consumed as design tokens. Listed names are exempt from the
   * `token-prefix-violation` check even when they do not match `tokenPrefix`
   * and are not in `tokenAllowlist`. Use this for cross-component runtime
   * variables (e.g. set in JS, read in CSS of a child). Component-local
   * variables that are both declared and consumed inside the same component's
   * own CSS file are auto-exempted and do not need an entry here.
   */
  runtimeVariables?: string[];
  /**
   * Chrome documents scanned by the `missing-token-link` validator to confirm
   * the tokens CSS file is `<link>`ed. Forks with multiple chrome host
   * documents (e.g. `mybrowser.xhtml` beside the stock `browser.xhtml`) should
   * list every document that may own the link. When omitted, defaults to
   * `['browser/base/content/browser.xhtml']` — the upstream Firefox path.
   */
  tokenHostDocuments?: string[];
  /**
   * Override the default Fluent (.ftl) base path within the engine.
   * Defaults to `toolkit/locales/en-US/toolkit/global` when not set.
   */
  ftlBasePath?: string;
  /**
   * Additional directories to scan for components (relative to engine root).
   * Always includes `toolkit/content/widgets` by default.
   */
  scanPaths?: string[];
  /**
   * Project-relative path to a consumer-owned jsconfig/tsconfig whose
   * `compilerOptions.paths` entries for deployed component modules
   * (`chrome://global/content/elements/<file>.mjs`) Furnace keeps in sync
   * on deploy. Only entries under that chrome prefix that map into
   * `components/custom/` are managed; everything else is preserved.
   * Unset disables jsconfig maintenance.
   */
  typecheckJsconfig?: string;
  /** Stock components tracked for preview */
  stock: string[];
  /** Override components */
  overrides: Record<string, OverrideComponentConfig>;
  /** Custom components */
  custom: Record<string, CustomComponentConfig>;
}

/**
 * Operations that can leave a pending-repair marker when they fail to roll
 * back cleanly. The marker is consumed by `fireforge doctor`, which either
 * re-runs apply for engine-side failures or validates the current authoring
 * state before clearing authoring markers. The string is surfaced in doctor's
 * failure message verbatim, so new entries should be self-explanatory.
 */
export type FurnacePendingRepairOperation =
  | 'preview-teardown'
  | 'apply-rollback'
  | 'deploy-rollback'
  | 'remove-rollback'
  | 'create-rollback'
  | 'override-rollback'
  | 'scan-rollback'
  | 'rename-rollback'
  | 'refresh-rollback'
  | 'chrome-doc-rollback';

/**
 * Marker persisted into `.fireforge/furnace-state.json` when a furnace
 * mutation failed to roll back cleanly. Its presence tells the next
 * `fireforge doctor` run that the engine and workspace may have drifted
 * out-of-band from what the state file records.
 */
export interface FurnacePendingRepair {
  /** The operation that failed to clean up; used by doctor to route the fix. */
  operation: FurnacePendingRepairOperation;
  /** ISO timestamp of when the repair marker was written. */
  timestamp: string;
  /** Human-readable summary of the failure; shown by doctor. */
  reason: string;
}

/**
 * State tracking for apply operations (stored in .fireforge/furnace-state.json).
 */
export interface FurnaceState {
  /** ISO timestamp of last successful apply */
  lastApply?: string;
  /** Checksums of component files at last apply, keyed by relative path */
  appliedChecksums?: Record<string, string>;
  /**
   * SHA-256 hashes of engine-side files written during the last apply, keyed
   * by engine-relative path. Used by drift detection to avoid byte-comparing
   * engine files against workspace sources when the cached hash still matches
   * the on-disk content. Populated alongside `appliedChecksums` on successful
   * apply.
   */
  engineChecksums?: Record<string, string>;
  /**
   * Set when a furnace mutation failed to roll back cleanly and the engine
   * may be in an inconsistent state. Cleared by `fireforge doctor` after
   * reconciliation. See {@link FurnacePendingRepair}.
   */
  pendingRepair?: FurnacePendingRepair;
}

/**
 * A registration-step error captured while applying a component.
 * In non-dry-run apply/deploy workflows, these trigger rollback of touched files.
 */
export interface StepError {
  step: string;
  error: string;
  /**
   * Advisory step errors are reported as warnings and never trigger
   * rollback or a non-zero exit. Used by the `.ftl` helpers, whose module
   * contract is graceful degradation: a missing locale jar.mn on a fork
   * without a locale package must not block a working `.mjs`/`.css` from
   * shipping. Before this flag existed the contract was contradicted in
   * practice — any FTL step error rolled back the entire apply, so a
   * localized component on such a fork could never be applied at all.
   */
  advisory?: boolean;
}

/**
 * Result of applying all components to the engine source tree.
 */
export interface ApplyResult {
  /** Components that were successfully applied */
  applied: Array<{
    name: string;
    type: ComponentType;
    filesAffected: string[];
    /** Non-fatal registration step errors */
    stepErrors?: StepError[];
  }>;
  /** Components that were skipped (e.g., no changes) */
  skipped: Array<{ name: string; reason: string }>;
  /** Components that failed to apply */
  errors: Array<{ name: string; error: string }>;
  /**
   * Set to true when the rollback journal was restored after a partial failure.
   * When true, entries in `applied` reflect what was attempted, not what
   * persisted — the engine has been restored to its pre-apply state.
   */
  rolledBack?: boolean;
}

/**
 * An action that would be performed during a dry-run deploy.
 */
export interface DryRunAction {
  component: string;
  action:
    | 'copy'
    | 'expand-fragments'
    | 'register-ce'
    | 'register-jar'
    | 'copy-ftl'
    | 'undeploy-remove'
    | 'undeploy-restore'
    | 'unregister-ce'
    | 'unregister-jar';
  source?: string;
  target?: string;
  description: string;
}

/**
 * Registration consistency status for a single component.
 */
export interface RegistrationStatus {
  sourceExists: boolean;
  targetExists: boolean;
  filesInSync: boolean;
  jarMnCss: boolean;
  jarMnMjs: boolean;
  customElementsPresent: boolean;
  customElementsCorrectBlock: boolean;
  driftedFiles: string[];
  missingTargetFiles: string[];
}

/**
 * Result of syncing Storybook story files.
 */
export interface SyncResult {
  /** Story files that were created */
  created: string[];
  /** Story files that were updated (regenerated) */
  updated: string[];
  /** Story files that were removed */
  removed: string[];
}

/**
 * A single validation finding for a furnace component.
 */
export interface ValidationIssue {
  /** Component tag name */
  component: string;
  /** Severity: 'error' blocks apply, 'warning' is advisory */
  severity: 'error' | 'warning';
  /** Short machine-readable check name (e.g., "missing-mjs", "no-aria-role") */
  check: string;
  /** Human-readable description of the issue */
  message: string;
}

/** Resolved test-harness selection for a `furnace create` run. */
export type ResolvedTestStyle = 'mochikit' | 'browser-chrome' | 'xpcshell' | 'none';
