// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for the `check` block (`fireforge check`).
 *
 * Split out of `config-validate.ts`, which is at its per-file line budget,
 * following the `config-validate-build-audit.ts` precedent. Unknown keys are
 * refused: a misspelt `extraSteps` would otherwise drop a project audit from
 * the gate without a word.
 */
import { ConfigError } from '../errors/config.js';
import {
  CHECK_BUILTIN_STEPS,
  type CheckBuiltinStep,
  type CheckConfig,
  type CheckExtraStep,
} from '../types/config.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';

const STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function assertKnownKeys(raw: Record<string, unknown>, field: string, known: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      throw new ConfigError(`Config field "${field}" has unknown key "${key}"`);
    }
  }
}

function parseStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new ConfigError(`Config field "${field}" must be an array of non-empty strings`);
  }
  return raw as string[];
}

function parseNonNegativeInteger(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new ConfigError(`Config field "${field}" must be a non-negative integer`);
  }
  return raw;
}

function isBuiltinStep(value: string): value is CheckBuiltinStep {
  return (CHECK_BUILTIN_STEPS as readonly string[]).includes(value);
}

function parseSkip(raw: unknown): CheckBuiltinStep[] {
  const skip = parseStringList(raw, 'check.skip');
  for (const entry of skip) {
    if (!isBuiltinStep(entry)) {
      throw new ConfigError(
        `Config field "check.skip" names unknown step "${entry}". Valid: ${CHECK_BUILTIN_STEPS.join(', ')}`
      );
    }
  }
  return skip as CheckBuiltinStep[];
}

function parseStatusPolicy(raw: unknown): NonNullable<CheckConfig['status']> {
  if (!isObject(raw)) throw new ConfigError('Config field "check.status" must be a plain object');
  assertKnownKeys(raw, 'check.status', ['failOn', 'allow', 'failOnUnknown']);
  const out: NonNullable<CheckConfig['status']> = {};
  if (raw['failOn'] !== undefined)
    out.failOn = parseStringList(raw['failOn'], 'check.status.failOn');
  if (raw['allow'] !== undefined) out.allow = parseStringList(raw['allow'], 'check.status.allow');
  if (raw['failOnUnknown'] !== undefined) {
    if (typeof raw['failOnUnknown'] !== 'boolean') {
      throw new ConfigError('Config field "check.status.failOnUnknown" must be a boolean');
    }
    out.failOnUnknown = raw['failOnUnknown'];
  }
  return out;
}

function parseMaxWarnings(raw: unknown): NonNullable<CheckConfig['maxWarnings']> {
  if (!isObject(raw)) {
    throw new ConfigError('Config field "check.maxWarnings" must be a plain object');
  }
  assertKnownKeys(raw, 'check.maxWarnings', ['lint', 'furnace']);
  const out: NonNullable<CheckConfig['maxWarnings']> = {};
  if (raw['lint'] !== undefined) {
    out.lint = parseNonNegativeInteger(raw['lint'], 'check.maxWarnings.lint');
  }
  if (raw['furnace'] !== undefined) {
    out.furnace = parseNonNegativeInteger(raw['furnace'], 'check.maxWarnings.furnace');
  }
  return out;
}

function parseExtraStep(raw: unknown, field: string): CheckExtraStep {
  if (!isObject(raw)) {
    throw new ConfigError(
      `Config field "${field}" must be a plain object with "name" and "command"`
    );
  }
  assertKnownKeys(raw, field, ['name', 'command', 'cwd', 'timeout']);
  const name = raw['name'];
  if (typeof name !== 'string' || !STEP_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Config field "${field}.name" must be lowercase letters, digits and dashes (e.g. "policy-audit")`
    );
  }
  if (isBuiltinStep(name)) {
    throw new ConfigError(`Config field "${field}.name" "${name}" is a built-in step name`);
  }
  const command = raw['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ConfigError(`Config field "${field}.command" must be a non-empty string`);
  }
  const step: CheckExtraStep = { name, command };
  if (raw['cwd'] !== undefined) {
    const cwd = raw['cwd'];
    if (typeof cwd !== 'string' || cwd.trim() === '' || !isContainedRelativePath(cwd)) {
      throw new ConfigError(`Config field "${field}.cwd" must be a project-relative path`);
    }
    step.cwd = cwd;
  }
  if (raw['timeout'] !== undefined) {
    const timeout = parseNonNegativeInteger(raw['timeout'], `${field}.timeout`);
    if (timeout === 0) {
      throw new ConfigError(`Config field "${field}.timeout" must be a positive number of seconds`);
    }
    step.timeout = timeout;
  }
  return step;
}

function parseExtraSteps(raw: unknown): CheckExtraStep[] {
  if (!Array.isArray(raw))
    throw new ConfigError('Config field "check.extraSteps" must be an array');
  const steps = raw.map((entry, index) =>
    parseExtraStep(entry, `check.extraSteps[${String(index)}]`)
  );
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.name)) {
      throw new ConfigError(`Config field "check.extraSteps" repeats the step name "${step.name}"`);
    }
    seen.add(step.name);
  }
  return steps;
}

/**
 * Parses the `check` block.
 *
 * @param raw - The raw `check` value from fireforge.json
 * @returns The validated block
 */
export function parseCheckConfig(raw: unknown): CheckConfig {
  if (!isObject(raw)) throw new ConfigError('Config field "check" must be a plain object');
  assertKnownKeys(raw, 'check', ['skip', 'status', 'maxWarnings', 'extraSteps']);
  const out: CheckConfig = {};
  if (raw['skip'] !== undefined) out.skip = parseSkip(raw['skip']);
  if (raw['status'] !== undefined) out.status = parseStatusPolicy(raw['status']);
  if (raw['maxWarnings'] !== undefined) out.maxWarnings = parseMaxWarnings(raw['maxWarnings']);
  if (raw['extraSteps'] !== undefined) out.extraSteps = parseExtraSteps(raw['extraSteps']);
  return out;
}
