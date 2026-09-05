// SPDX-License-Identifier: EUPL-1.2
/**
 * FireForge: a toolkit for building and maintaining Firefox-based browsers.
 *
 * This module re-exports the public API surface used by downstream consumers.
 * For CLI usage, see `bin/fireforge.ts`.
 *
 * Stability: pre-1.0. The exports listed here are functional and tested,
 * but may change between minor versions until 1.0 is released. Pin to an
 * exact version if you depend on the programmatic API.
 *
 * What belongs here: a type earns a place on this surface only if it is
 * reachable from the signature of an exported value, i.e. a consumer needs
 * it to name an argument or a return. Everything else stays internal to
 * `src/types/`.
 *
 * @packageDocumentation
 */
export { loadConfig, validateConfig } from './core/config.js';
export type { ApplyAllComponentsResult } from './core/furnace-apply.js';
export { applyAllComponents } from './core/furnace-apply.js';
export {
  ensureFurnaceConfig,
  loadFurnaceConfig,
  loadFurnaceState,
  saveFurnaceState,
  validateFurnaceConfig,
} from './core/furnace-config.js';
export { validateAllComponents, validateComponent } from './core/furnace-validate.js';
export type { PatchSizeTierDecision } from './core/patch-lint.js';
export {
  countNonBinaryDiffLines,
  getPatchSizeThresholds,
  resolvePatchSizeTier,
} from './core/patch-lint.js';
export type { AddTokenOptions, AddTokenResult, TokenMode } from './core/token-manager.js';
export { addToken, getTokensCssPath, validateTokenAdd } from './core/token-manager.js';
export {
  CancellationError,
  CommandError,
  FireForgeError,
  GeneralError,
  InvalidArgumentError,
  ResolutionError,
} from './errors/base.js';
export { ExitCode } from './errors/codes.js';
export type {
  ApplyResult,
  BuildConfig,
  ComponentType,
  CustomComponentConfig,
  DryRunAction,
  FireForgeConfig,
  FirefoxConfig,
  FirefoxProduct,
  FurnaceConfig,
  FurnaceState,
  OverrideComponentConfig,
  OverrideType,
  ProjectLicense,
  StepError,
  ValidationIssue,
  WireConfig,
} from './types/index.js';
