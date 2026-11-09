// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { stepTraits } from './step-traits.js';
import {
  assertStepValidator,
  escapesSlot,
  OUTPUT_PLACEHOLDER,
  outputOptionValues,
  type StepValidator,
} from './step-validate.js';

export { escapesSlot } from './step-validate.js';

/** The `taskpolicy` clamps a step can run its browser under. */
const THROTTLES = {
  background: ['--debugger-args=-b'],
  utility: ['--debugger-args=-c utility'],
} as const;
export type StepThrottle = keyof typeof THROTTLES;

/** The fixed Mach arguments a clamp becomes: the only way a job runs its browser under another program. */
export function throttleArguments(throttle: StepThrottle | undefined): string[] {
  if (throttle === undefined) return [];
  return ['--debugger=taskpolicy', ...THROTTLES[throttle]].map((arg) => `--mach-arg=${arg}`);
}

/** What a step can declare about the process it runs in, beyond its adapter's arguments. */
export interface StepDeclaration {
  command: string;
  args: readonly string[];
  /** Environment for the harness. Names are validated; values are visible in `job status`. */
  env?: Record<string, string>;
  /** Give the harness a private `MOZ_UPLOAD_DIR` inside this job's artifacts. */
  uploadDir?: boolean;
  /** Hold a display and idle assertion for the phase, on darwin. A step with a window defaults to it. */
  keepAwake?: boolean;
  /** Keep the step's own browser frontmost, on darwin. Red if it could not. */
  holdFront?: boolean;
  /** Run the browser under a fixed `taskpolicy` clamp. */
  throttle?: StepThrottle;
  /** Judges what the harness produced, after it exits clean, in the same phase. */
  validate?: StepValidator;
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 4096;

/**
 * Names a declaration never sets. Each one either selects code the executor runs,
 * changes how a tool identity or the build reads, or is something this process owns.
 */
const RESERVED_PREFIXES = [
  'FIREFORGE_',
  'NODE_',
  'NPM_',
  'TSX_',
  'JITI_',
  'MOZ_',
  'MOZBUILD_',
  'MACH',
  'GIT_',
  'PYTHON',
  'PIP_',
  'UV_',
  'VIRTUAL_ENV',
  'CONDA_',
  'DYLD_',
  'LD_',
  'MALLOC',
  'CARGO',
  'RUST',
  'SCCACHE_',
  'CCACHE_',
  'XDG_',
  'LC_',
  'SSH_',
];
const RESERVED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'ENV',
  'BASH_ENV',
  'CDPATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'MOZCONFIG',
  'CC',
  'CXX',
  'CPP',
  'AR',
  'AS',
  'LD',
  'NM',
  'STRIP',
  'RANLIB',
  'OBJCOPY',
  'CFLAGS',
  'CXXFLAGS',
  'CPPFLAGS',
  'LDFLAGS',
  'HOST_CC',
  'HOST_CXX',
  'HOST_AR',
  'DSYMUTIL',
  'CBINDGEN',
  'NODEJS',
  'CLANG_PATH',
  'LIBCLANG_PATH',
  'WASI_SYSROOT',
  'MACOS_SDK_DIR',
  'WASM_CC',
  'WASM_CXX',
  'ONNX_RUNTIME',
]);

function assertValue(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH || /[\0\r\n]/.test(value))
    throw new Error(
      `Step environment ${name} must be one line of at most ${String(MAX_VALUE_LENGTH)} characters`
    );
  const inOutput = value.startsWith(`${OUTPUT_PLACEHOLDER}/`) || value === OUTPUT_PLACEHOLDER;
  const path = inOutput ? value.slice(OUTPUT_PLACEHOLDER.length + 1) : value;
  if (path.includes(OUTPUT_PLACEHOLDER) || escapesSlot(path))
    throw new Error(
      `Step environment ${name} names a path outside the job. Use a path relative to the slot, or start it with ${OUTPUT_PLACEHOLDER}`
    );
}

/** Refuses a name or value that could change how the executor behaves rather than what a test reads. */
export function assertDeclaredEnvironment(raw: unknown): asserts raw is Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Step env must map names to values');
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME.test(name))
      throw new Error(`Step environment name ${name} must be upper case letters, digits and _`);
    if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)))
      throw new Error(
        `Step environment ${name} is refused: the executor owns it${name === 'MOZ_UPLOAD_DIR' ? '. Set uploadDir for a private upload directory' : ''}`
      );
    assertValue(name, value);
  }
}

/** The declaration part of a step's validation. */
export function assertStepDeclaration(step: StepDeclaration): void {
  for (const field of ['uploadDir', 'keepAwake', 'holdFront'] as const)
    if (step[field] !== undefined && typeof step[field] !== 'boolean')
      throw new Error(`Step ${field} must be a boolean`);
  if (step.holdFront === true && !stepTraits(step).display)
    throw new Error('Step holdFront applies to a test or run with a window: drop --headless');
  if (step.throttle !== undefined) {
    if (!Object.keys(THROTTLES).includes(step.throttle))
      throw new Error(`Step throttle must be one of: ${Object.keys(THROTTLES).join(', ')}`);
    if (step.command !== 'test' || stepTraits(step).builds)
      throw new Error('Step throttle applies to a test with no build in it');
  }
  if (step.env === undefined && step.uploadDir === undefined && step.validate === undefined) return;
  if (step.env !== undefined) assertDeclaredEnvironment(step.env);
  if (step.validate !== undefined) assertStepValidator(step.validate);
  const traits = stepTraits(step);
  // A build under a declared environment would produce a binary its anchor knows nothing about.
  if (!traits.browser || traits.builds)
    throw new Error(
      `Step env, uploadDir and validate apply to a test or run with no build in it, not ${step.command}`
    );
}

/** Whether this step writes to a directory of its own, and so whether there is a path to report. */
const hasOutput = (step: StepDeclaration): boolean =>
  step.uploadDir === true ||
  Object.values(step.env ?? {}).some((value) => value.startsWith(OUTPUT_PLACEHOLDER)) ||
  (step.validate?.command ?? []).some((arg) => arg.includes(OUTPUT_PLACEHOLDER)) ||
  outputOptionValues(step.command, step.args).some((value) => value.includes(OUTPUT_PLACEHOLDER)) ||
  stepTraits(step).releaseBuild;

/** A step's private output directory: under its job, so no other job or slot ever shares it. */
export const stepOutputDirectory = (
  namespace: string,
  jobId: string,
  index: number,
  step: StepDeclaration
): string | undefined =>
  hasOutput(step) ? join(namespace, 'artifacts', jobId, `step-${String(index)}-output`) : undefined;

/** The variables a step's declaration adds, with its output directory filled in. */
export function declaredProcessEnvironment(
  step: StepDeclaration,
  output: string | undefined
): Record<string, string> {
  const expand = (value: string): string =>
    output !== undefined && value.startsWith(OUTPUT_PLACEHOLDER)
      ? `${output}${value.slice(OUTPUT_PLACEHOLDER.length)}`
      : value;
  return {
    ...Object.fromEntries(
      Object.entries(step.env ?? {}).map(([name, value]) => [name, expand(value)])
    ),
    ...(step.uploadDir === true && output !== undefined ? { MOZ_UPLOAD_DIR: output } : {}),
  };
}

/** `NAME=VALUE` from a command line. */
export function parseEnvironmentAssignments(
  assignments: readonly string[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const split = assignment.indexOf('=');
    if (split < 1) throw new Error(`--env takes NAME=VALUE, not ${assignment}`);
    env[assignment.slice(0, split)] = assignment.slice(split + 1);
  }
  assertDeclaredEnvironment(env);
  return env;
}
