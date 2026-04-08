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
  /** Stock components tracked for preview */
  stock: string[];
  /** Override components */
  overrides: Record<string, OverrideComponentConfig>;
  /** Custom components */
  custom: Record<string, CustomComponentConfig>;
}

/**
 * State tracking for apply operations (stored in .fireforge/furnace-state.json).
 */
export interface FurnaceState {
  /** ISO timestamp of last successful apply */
  lastApply?: string;
  /** Checksums of component files at last apply, keyed by relative path */
  appliedChecksums?: Record<string, string>;
}

/**
 * A registration-step error captured while applying a component.
 * In non-dry-run apply/deploy workflows, these trigger rollback of touched files.
 */
export interface StepError {
  step: string;
  error: string;
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
}

/**
 * An action that would be performed during a dry-run deploy.
 */
export interface DryRunAction {
  component: string;
  action: 'copy' | 'register-ce' | 'register-jar' | 'copy-ftl';
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
