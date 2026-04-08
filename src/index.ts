// SPDX-License-Identifier: EUPL-1.2
/**
 * FireForge — a toolkit for building and maintaining Firefox-based browsers.
 *
 * This module re-exports the public API surface used by downstream consumers.
 * For CLI usage, see `bin/fireforge.ts`.
 *
 * **Stability:** Pre-1.0. The exports listed here are functional and tested,
 * but may change between minor versions until 1.0 is released. Pin to an
 * exact version if you depend on the programmatic API.
 *
 * @packageDocumentation
 */
export { loadConfig, validateConfig } from './core/config.js';
export { applyAllComponents } from './core/furnace-apply.js';
export {
  ensureFurnaceConfig,
  loadFurnaceConfig,
  loadFurnaceState,
  saveFurnaceState,
  validateFurnaceConfig,
} from './core/furnace-config.js';
export { validateAllComponents, validateComponent } from './core/furnace-validate.js';
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
  BuildMode,
  BuildOptions,
  ComponentType,
  CustomComponentConfig,
  DiscardOptions,
  DoctorCheck,
  DownloadOptions,
  DryRunAction,
  ExportOptions,
  FireForgeConfig,
  FireForgeState,
  FirefoxConfig,
  FirefoxProduct,
  FurnaceConfig,
  FurnaceCreateOptions,
  FurnaceOverrideOptions,
  FurnaceRemoveOptions,
  FurnaceState,
  GlobalOptions,
  ImportOptions,
  ImportSummary,
  OverrideComponentConfig,
  OverrideType,
  PackageOptions,
  PatchCategory,
  PatchesManifest,
  PatchInfo,
  PatchLintIssue,
  PatchMetadata,
  PatchResult,
  ProjectLicense,
  ProjectPaths,
  ProjectStatus,
  ReExportOptions,
  RegistrationStatus,
  ResetOptions,
  RunOptions,
  ScannedComponent,
  SetupOptions,
  StepError,
  SyncResult,
  TestOptions,
  TokenCoverageFileEntry,
  TokenCoverageReport,
  ValidationIssue,
  WireConfig,
} from './types/index.js';
