// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge.json`: its schema (the single source of its types, validation,
 * key paths and key documentation), loading, and editing one key at a time.
 */
export { coerceConfigValue, configKeys, getConfigValue, setConfigValue } from './edit.js';
export { CONFIG_FILE, loadConfig, readConfigDocument } from './load.js';
export { type ConfigUpgrade, upgradeConfig, type UpgradeNote } from './previous.js';
export { CHECK_STEPS, type CheckExtraStep, type CheckStep } from './schema/check.js';
export type { ExportQueueConfig } from './schema/export-queue.js';
export {
  FIREFOX_PRODUCTS,
  type FirefoxConfig,
  type FirefoxProduct,
  inferFirefoxProduct,
} from './schema/firefox.js';
export { ARTIFACTS_PLACEHOLDER, type GateConfig, type GateLane } from './schema/gate.js';
export { DEFAULT_LICENSE, markerComment, PROJECT_LICENSES } from './schema/identity.js';
export { configSchema, type FireForgeConfig } from './schema/index.js';
export {
  fileSizeBands,
  LINT_RULE_IDS,
  type LintRuleId,
  matchesPropertyName,
  type PatchLintConfig,
  patchSizeBands,
  type PatchSizeTier,
  type SizeBands,
} from './schema/lint.js';
export type { PatchPolicyConfig } from './schema/policy.js';
export { PROJECT_MODES, type ProjectMode, type SourceConfig } from './schema/source.js';
export type { TypecheckConfig } from './schema/typecheck.js';
