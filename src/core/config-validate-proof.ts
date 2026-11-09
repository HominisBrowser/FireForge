// SPDX-License-Identifier: EUPL-1.2
/** Validates the `proof` block: what a project's gate requires, stated as data with no unknown key. */
import { ConfigError } from '../errors/config.js';
import type {
  ProofAcceptanceConfig,
  ProofConfig,
  ProofControlConfig,
  ProofGateConfig,
  ProofLaneConfig,
  ProofRunConfig,
  ProofStressConfig,
} from '../types/config.js';
import { toError } from '../utils/errors.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';
import { assertKnownConfigKeys } from './config-validate-keys.js';
import { adapterPositionals, validateAdapterArguments } from './jobs/adapter-arguments.js';
import { assertDeclaredEnvironment } from './jobs/step-environment.js';
import { assertStepValidator } from './jobs/step-validate.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** Planned by FireForge when the declaration itself changes. */
const RESERVED_ACCEPTANCE = 'proof-config';
/** The planner owns these: a lane states the same things through its own fields. */
const PLANNER_OPTIONS = [
  '--headless',
  '--auto-ports',
  '--no-shard',
  '--restart-between-tests',
  '--repeat',
  '--negative-control',
  '--build',
  '--build-only',
  '--mach-arg',
];

type Raw = Record<string, unknown>;

function record(raw: unknown, field: string, keys: readonly string[]): Raw {
  if (!isObject(raw)) throw new ConfigError(`Config field "${field}" must be an object`);
  assertKnownConfigKeys(Object.keys(raw), keys, field);
  return raw;
}

function strings(raw: unknown, field: string): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((entry) => typeof entry !== 'string' || entry === '')
  )
    throw new ConfigError(`Config field "${field}" must be a non-empty array of non-empty strings`);
  return raw as string[];
}

function paths(raw: unknown, field: string): string[] {
  const list = strings(raw, field);
  for (const entry of list)
    if (!isContainedRelativePath(entry))
      throw new ConfigError(`Config field "${field}" must hold project-relative paths: ${entry}`);
  return list;
}

function flag(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') throw new ConfigError(`Config field "${field}" must be a boolean`);
  return raw;
}

function positive(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1)
    throw new ConfigError(`Config field "${field}" must be a positive whole number`);
  return raw;
}

function text(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw === '')
    throw new ConfigError(`Config field "${field}" must be a non-empty string`);
  return raw;
}

function testArguments(raw: unknown, field: string): string[] {
  const args = strings(raw, field);
  try {
    validateAdapterArguments({ command: 'test', args });
    if (adapterPositionals({ command: 'test', args }).length > 0)
      throw new Error('it names files through `files`, not arguments');
  } catch (error) {
    throw new ConfigError(`Config field "${field}" is refused: ${toError(error).message}`);
  }
  const owned = args.find((arg) => PLANNER_OPTIONS.includes(arg.split('=')[0] ?? ''));
  if (owned !== undefined)
    throw new ConfigError(
      `Config field "${field}" cannot set ${owned}: dispatch, headed, repeat, controls and machArgs have their own fields, and the plan runs the build`
    );
  return args;
}

function environment(raw: unknown, field: string): Record<string, string> {
  try {
    assertDeclaredEnvironment(raw);
  } catch (error) {
    throw new ConfigError(`Config field "${field}" is refused: ${toError(error).message}`);
  }
  return raw;
}

function machArguments(raw: unknown, field: string): string[] {
  const list = strings(raw, field);
  try {
    validateAdapterArguments({ command: 'test', args: list.map((arg) => `--mach-arg=${arg}`) });
  } catch (error) {
    throw new ConfigError(`Config field "${field}" is refused: ${toError(error).message}`);
  }
  return list;
}

function validator(raw: unknown, field: string): NonNullable<ProofLaneConfig['validate']> {
  try {
    assertStepValidator(raw);
  } catch (error) {
    throw new ConfigError(`Config field "${field}" is refused: ${toError(error).message}`);
  }
  return raw;
}

/** Each entry of a list of declarations with unique IDs. */
function declarations<T extends { id: string }>(
  raw: unknown,
  field: string,
  parse: (entry: unknown, at: string) => T
): T[] {
  if (!Array.isArray(raw)) throw new ConfigError(`Config field "${field}" must be an array`);
  const parsed = raw.map((entry, index) => parse(entry, `${field}[${String(index)}]`));
  const seen = new Set<string>();
  for (const { id } of parsed) {
    if (!ID_PATTERN.test(id) || seen.has(id))
      throw new ConfigError(`Config field "${field}" needs unique lower-case IDs, not "${id}"`);
    seen.add(id);
  }
  return parsed;
}

/** The fields present on a raw object, each through its parser, so an absent one stays absent. */
function optional<T extends object>(
  raw: Raw,
  at: string,
  parsers: { [K in keyof T]: (value: unknown, field: string) => T[K] }
): T {
  const result: Partial<T> = {};
  for (const key of Object.keys(parsers) as Array<keyof T & string>)
    if (raw[key] !== undefined) result[key] = parsers[key](raw[key], `${at}.${key}`);
  return result as T;
}

const LANE_KEYS = [
  'id',
  'files',
  'exclude',
  'owns',
  'dispatch',
  'headed',
  'quiet',
  'args',
  'env',
  'uploadDir',
  'machArgs',
  'keepAwake',
  'holdFront',
  'throttle',
  'validate',
];

function dispatchOf(raw: unknown, field: string): NonNullable<ProofLaneConfig['dispatch']> {
  if (raw !== 'shards' && raw !== 'one-browser' && raw !== 'standalone')
    throw new ConfigError(`Config field "${field}" must be shards, one-browser or standalone`);
  return raw;
}

function throttleOf(raw: unknown, field: string): NonNullable<ProofLaneConfig['throttle']> {
  if (raw !== 'background' && raw !== 'utility')
    throw new ConfigError(`Config field "${field}" must be background or utility`);
  return raw;
}

function laneFields(raw: Raw, at: string): ProofLaneConfig {
  return {
    id: text(raw['id'], `${at}.id`),
    files: paths(raw['files'], `${at}.files`),
    ...optional<Omit<ProofLaneConfig, 'id' | 'files'>>(raw, at, {
      exclude: paths,
      owns: paths,
      dispatch: dispatchOf,
      headed: flag,
      quiet: flag,
      args: testArguments,
      env: environment,
      uploadDir: flag,
      machArgs: machArguments,
      keepAwake: flag,
      holdFront: flag,
      throttle: throttleOf,
      validate: validator,
    }),
  };
}

function parseLane(raw: unknown, at: string): ProofLaneConfig {
  return laneFields(record(raw, at, LANE_KEYS), at);
}

function parseStress(raw: unknown, at: string): ProofStressConfig {
  const entry = record(raw, at, [...LANE_KEYS, 'repeat', 'context']);
  return {
    ...laneFields(entry, at),
    repeat: positive(entry['repeat'], `${at}.repeat`),
    ...optional<Pick<ProofStressConfig, 'context'>>(entry, at, { context: paths }),
  };
}

function parseControl(raw: unknown, at: string): ProofControlConfig {
  const entry = record(raw, at, ['id', 'diff', 'test', 'assertions', 'compiled', 'always']);
  return {
    id: text(entry['id'], `${at}.id`),
    diff: paths([entry['diff']], `${at}.diff`)[0] ?? '',
    test: paths([entry['test']], `${at}.test`)[0] ?? '',
    assertions: strings(entry['assertions'], `${at}.assertions`),
    ...optional<Pick<ProofControlConfig, 'compiled' | 'always'>>(entry, at, {
      compiled: flag,
      always: flag,
    }),
  };
}

function parseRun(raw: unknown, at: string): ProofRunConfig {
  const entry = record(raw, at, [
    'id',
    'args',
    'quiet',
    'env',
    'uploadDir',
    'keepAwake',
    'validate',
  ]);
  const args = strings(entry['args'], `${at}.args`);
  try {
    validateAdapterArguments({ command: 'run', args });
  } catch (error) {
    throw new ConfigError(`Config field "${at}.args" is refused: ${toError(error).message}`);
  }
  return {
    id: text(entry['id'], `${at}.id`),
    args,
    ...optional<Pick<ProofRunConfig, 'quiet' | 'env' | 'uploadDir' | 'keepAwake' | 'validate'>>(
      entry,
      at,
      { quiet: flag, env: environment, uploadDir: flag, keepAwake: flag, validate: validator }
    ),
  };
}

function parseAcceptance(raw: unknown, at: string): ProofAcceptanceConfig {
  const entry = record(raw, at, ['id', 'reason', 'owns', 'evidence']);
  const id = text(entry['id'], `${at}.id`);
  if (id === RESERVED_ACCEPTANCE)
    throw new ConfigError(`Config field "${at}.id" cannot be ${id}: FireForge plans that one`);
  return {
    id,
    reason: text(entry['reason'], `${at}.reason`),
    ...optional<Pick<ProofAcceptanceConfig, 'owns' | 'evidence'>>(entry, at, {
      owns: paths,
      evidence: strings,
    }),
  };
}

/** An acceptance can only stand on something this gate declares and runs. */
function assertAcceptanceEvidence(gate: ProofGateConfig): void {
  const declared = new Set([
    ...(gate.lanes ?? []).map(({ id }) => `lane:${id}`),
    ...(gate.stress ?? []).map(({ id }) => `stress:${id}`),
    ...(gate.controls ?? []).map(({ id }) => `control:${id}`),
    ...(gate.runs ?? []).map(({ id }) => `run:${id}`),
  ]);
  for (const entry of gate.acceptance ?? [])
    for (const id of entry.evidence ?? [])
      if (!declared.has(id))
        throw new ConfigError(
          `Config field "proof.gate.acceptance" entry ${entry.id} names ${id}, which this gate does not declare`
        );
}

function buildKind(raw: unknown, field: string): NonNullable<ProofGateConfig['build']> {
  if (raw !== 'ui' && raw !== 'full')
    throw new ConfigError(`Config field "${field}" must be ui or full`);
  return raw;
}

function modeOf(raw: unknown, field: string): NonNullable<ProofGateConfig['mode']> {
  if (raw !== 'dev' && raw !== 'debug' && raw !== 'release')
    throw new ConfigError(`Config field "${field}" must be dev, debug or release`);
  return raw;
}

function checkOptions(raw: unknown, field: string): NonNullable<ProofGateConfig['check']> {
  return optional(record(raw, field, ['quiet']), field, { quiet: flag });
}

const listOf =
  <T extends { id: string }>(parse: (entry: unknown, at: string) => T) =>
  (raw: unknown, field: string): T[] =>
    declarations(raw, field, parse);

function parseGate(raw: unknown, field: string): ProofGateConfig {
  const gate = record(raw, field, [
    'build',
    'mode',
    'check',
    'lanes',
    'stress',
    'controls',
    'runs',
    'acceptance',
  ]);
  const parsed = optional<ProofGateConfig>(gate, field, {
    build: buildKind,
    mode: modeOf,
    check: checkOptions,
    lanes: listOf(parseLane),
    stress: listOf(parseStress),
    controls: listOf(parseControl),
    runs: listOf(parseRun),
    acceptance: listOf(parseAcceptance),
  });
  assertAcceptanceEvidence(parsed);
  return parsed;
}

/** @param raw - The value of the `proof` key */
export function parseProofConfig(raw: unknown): ProofConfig {
  const proof = record(raw, 'proof', ['mainBranch', 'consumerLimit', 'noneRoutes', 'gate']);
  return optional<ProofConfig>(proof, 'proof', {
    mainBranch: text,
    consumerLimit: positive,
    noneRoutes: paths,
    gate: parseGate,
  });
}
