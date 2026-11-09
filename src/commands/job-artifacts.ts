// SPDX-License-Identifier: EUPL-1.2
/**
 * The `job run` flags that name a file a test writes. A job writes only into its
 * step's output directory, `{artifacts}`, so each value is a name inside it,
 * and once the job ends the command says where each one landed.
 */
import { posix } from 'node:path';

import { type JobView } from '../core/jobs/schema.js';
import { OUTPUT_PLACEHOLDER, outputOptionValues } from '../core/jobs/step-validate.js';
import { InvalidArgumentError } from '../errors/base.js';

/** The test flags whose value names what the harness writes, by flag. */
const WRITTEN = ['--coverage', '--perf-samples', '--keep-log'] as const;

export interface ArtifactFlags {
  coverage?: string;
  perfSamples?: string;
  keepLog?: string;
  profileFile?: string[];
}

/** A plain relative path that stays where it is put: no root, home, `..` or empty segment. */
function plainRelative(flag: string, value: string, what: string): string {
  const trimmed = value.replace(/\/+$/, '');
  const normal = posix.normalize(trimmed);
  if (
    value === '' ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    value.includes('\0') ||
    normal === '.' ||
    normal.split('/').includes('..') ||
    normal !== trimmed
  )
    throw new InvalidArgumentError(
      `${flag} ${value}: name a plain relative path ${what}, with no leading /, ~ or .. part`,
      flag
    );
  return normal;
}

/** `cov` and `{artifacts}/cov` both name `{artifacts}/cov`. */
export function artifactPath(flag: string, value: string): string {
  const prefix = `${OUTPUT_PLACEHOLDER}/`;
  const inner = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return `${prefix}${plainRelative(flag, inner, "inside the job's artifacts")}`;
}

/** Whether any flag here was named. */
export const namesArtifacts = (flags: ArtifactFlags): boolean =>
  flags.coverage !== undefined ||
  flags.perfSamples !== undefined ||
  flags.keepLog !== undefined ||
  flags.profileFile !== undefined;

/**
 * The test step's arguments these flags become. `--profile-file` reads a
 * captured file into the harness profile, so both its sides stay relative.
 */
export function artifactArguments(flags: ArtifactFlags): string[] {
  const values: Record<(typeof WRITTEN)[number], string | undefined> = {
    '--coverage': flags.coverage,
    '--perf-samples': flags.perfSamples,
    '--keep-log': flags.keepLog,
  };
  const args = WRITTEN.flatMap((flag) => {
    const value = values[flag];
    return value === undefined ? [] : [flag, artifactPath(flag, value)];
  });
  for (const pair of flags.profileFile ?? []) {
    const [source = '', destination = '', ...rest] = pair.split('=');
    if (rest.length > 0 || destination === '')
      throw new InvalidArgumentError(
        `--profile-file ${pair}: name it as <captured source>=<path in the profile>`,
        '--profile-file'
      );
    args.push(
      '--profile-file',
      `${plainRelative('--profile-file', source, 'in the captured checkout')}=${plainRelative('--profile-file', destination, 'in the profile')}`
    );
  }
  return args;
}

/** Where each named artifact of a finished job is, as `--flag: path` lines. */
export function artifactLocations(job: JobView): string[] {
  return (job.outputs ?? []).flatMap(({ step, path }) => {
    const request = job.request.steps[step];
    if (request === undefined) return [];
    const named = new Map<string, string>();
    request.args.forEach((arg, index) => {
      const value = request.args[index + 1];
      if (value !== undefined && outputOptionValues(request.command, [arg, value]).length > 0)
        named.set(value, arg);
    });
    return outputOptionValues(request.command, request.args)
      .filter((value) => value.startsWith(OUTPUT_PLACEHOLDER))
      .map(
        (value) =>
          `Job ${job.id} ${named.get(value) ?? 'artifact'}: ${value.replace(OUTPUT_PLACEHOLDER, path)}`
      );
  });
}
