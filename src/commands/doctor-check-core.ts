// SPDX-License-Identifier: EUPL-1.2
/**
 * Doctor check types and lightweight result builders shared between
 * `doctor.ts` and sibling check modules. Kept separate so registries can import
 * these symbols without creating cycles through `doctor.ts`.
 */

import type { DoctorCheck, DoctorOptions } from '../types/commands/index.js';
import type { FireForgeConfig, FireForgeState, ProjectPaths } from '../types/config.js';
import type { FurnaceConfig } from '../types/furnace.js';

/**
 * Shared state available to every doctor check during a single run.
 *
 * The context is populated lazily by the doctor runner. Individual checks
 * can record side-observations (e.g. the parsed `fireforge.json`) into the
 * context for later checks to consume without re-parsing.
 */
export interface DoctorCheckContext {
  projectRoot: string;
  paths: ProjectPaths;
  state: FireForgeState;
  options: DoctorOptions;
  /**
   * Whether the engine/ directory exists on disk. Populated before checks
   * run so downstream checks can skip git/mach inspections cheaply.
   */
  engineExists: boolean;
  /**
   * The loaded project config, set by the "fireforge.json is valid" check
   * when it succeeds. Undefined before that check runs and whenever loading
   * failed.
   */
  config: FireForgeConfig | undefined;
  /**
   * Whether `furnace.json` exists on disk. Populated before checks run so
   * the furnace group can skipIf cheaply when the subsystem is not in use.
   */
  furnaceConfigExists: boolean;
  /**
   * The parsed furnace config, set by the "Furnace configuration" check
   * when it succeeds. Later furnace checks read from this so they do not
   * re-parse the file; undefined when the config could not be loaded.
   */
  furnaceConfig: FurnaceConfig | undefined;
  /**
   * State this run actually mutated, one human-readable line per write.
   * Repairs run inside the check loop while the exit code is computed only
   * after every check, so a repair can land and the run still exit non-zero
   * on an unrelated check — and a non-zero exit reads as "nothing happened".
   * The runner prints these before the summary in every branch so a write is
   * never invisible.
   */
  mutations: string[];
}

/**
 * Result a check may return. A single object is the common case; an array
 * lets a single check emit multiple related rows (e.g. the engine branch
 * check which may report on branch + detached state together).
 */
export type CheckResult = DoctorCheck | DoctorCheck[];

/**
 * Declarative definition of a single doctor check.
 *
 * Every check opts into the shared execution/reporting pipeline by
 * implementing only its inspection logic in `run`. Cross-cutting concerns
 * (result aggregation, summary, exit codes) live in the runner instead of
 * being duplicated at each call site.
 */
export interface DoctorCheckDefinition {
  /**
   * Human-readable name surfaced in the check report (e.g. "Git installed").
   * Not required to be unique, but tests assert on it.
   */
  name: string;
  /**
   * When `true`, the check is silently skipped. Used for checks that only
   * apply when the engine is present, or only when specific state flags
   * are set. Skipped checks contribute nothing to the final report.
   */
  skipIf?: (ctx: DoctorCheckContext) => boolean;
  /**
   * Names of checks that must appear earlier in the registry and run before
   * this check. Enforced at startup via validateCheckDependencies so
   * accidental reorders surface immediately instead of producing subtle
   * context-population bugs at runtime.
   */
  dependsOn?: readonly string[];
  /**
   * Runs the inspection. Throwing is shorthand for "this check failed with
   * severity 'error'" — the runner converts the exception message into a
   * DoctorCheck. Returning a DoctorCheck (or array) lets the check control
   * severity, warnings, and fix hints directly.
   */
  run: (ctx: DoctorCheckContext) => CheckResult | Promise<CheckResult>;
  /**
   * Optional recovery hint attached to the auto-generated failure result
   * when `run` throws. Ignored when `run` returns a DoctorCheck explicitly.
   */
  fix?: string;
}

/**
 * Resolves a {@link DoctorCheck} to its effective severity. `severity` is the
 * single source of truth; this exists so every consumer of a
 * `DoctorCheck[]` reads it the same way.
 */
export function resolveDoctorSeverity(check: DoctorCheck): 'ok' | 'warning' | 'error' {
  return check.severity;
}

/**
 * Builds a DoctorCheck object representing a successful "OK" check.
 */
export function ok(name: string, message = 'OK'): DoctorCheck {
  return { name, severity: 'ok', message };
}

/**
 * Builds a DoctorCheck object representing a warning result.
 */
export function warning(name: string, message: string, fix?: string): DoctorCheck {
  return { name, severity: 'warning', message, ...(fix ? { fix } : {}) };
}

/**
 * Builds a DoctorCheck object representing a failure result.
 */
export function failure(name: string, message: string, fix?: string): DoctorCheck {
  return { name, severity: 'error', message, ...(fix ? { fix } : {}) };
}
