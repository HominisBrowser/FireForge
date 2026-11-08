// SPDX-License-Identifier: EUPL-1.2
/** Validates what a project's slots hold and how its release package is built. */
import { posix } from 'node:path';

import { ConfigError } from '../errors/config.js';
import type { BuildReleaseConfig, DependencyCacheConfig, SlotsConfig } from '../types/config.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';
import { assertKnownConfigKeys } from './config-validate-keys.js';

/** A path relative to a project or slot root, outside what the runtime owns there. */
function rootPath(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !isContainedRelativePath(raw))
    throw new ConfigError(`Config field "${field}" must be a relative path inside the project`);
  return raw;
}

/** One spelling per path: what names a slot's tree is compared and deleted by this string. */
const isCanonicalPath = (path: string): boolean =>
  isContainedRelativePath(path) &&
  path !== '.' &&
  !path.includes('\\') &&
  !path.endsWith('/') &&
  posix.normalize(path) === path;

/**
 * Why a path cannot be a slot's dependency tree, if so. Replacing a tree deletes
 * this path, so it can name nothing a slot's runtime or engine source owns. Inside
 * the engine that leaves a `node_modules`, which upstream does not track. Compared
 * case-insensitively, as a slot's file system may.
 */
export function cacheTargetProblem(target: string): string | undefined {
  if (!isCanonicalPath(target)) return 'must be a canonical relative path inside the slot';
  const parts = target.toLowerCase().split('/');
  if (parts.includes('.git') || parts.includes('.fireforge'))
    return "names what a slot's runtime owns";
  if (parts[0] !== 'engine') return undefined;
  const inside = parts.slice(1);
  return target.startsWith('engine/') &&
    target.endsWith('/node_modules') &&
    !inside.some((part) => part.startsWith('obj-'))
    ? undefined
    : 'overlaps engine source: inside engine/ only a node_modules tree can be a cache';
}

function parseCache(raw: unknown, field: string): DependencyCacheConfig {
  if (!isObject(raw)) throw new ConfigError(`Config field "${field}" must be an object`);
  assertKnownConfigKeys(Object.keys(raw), ['source', 'target', 'lockfile'], field);
  const target = rootPath(raw['target'], `${field}.target`);
  const problem = cacheTargetProblem(target);
  if (problem !== undefined) throw new ConfigError(`Config field "${field}.target" ${problem}`);
  const canonical = (value: unknown, name: string): string => {
    const path = rootPath(value, `${field}.${name}`);
    if (!isCanonicalPath(path))
      throw new ConfigError(`Config field "${field}.${name}" must be a canonical relative path`);
    return path;
  };
  return {
    source: canonical(raw['source'], 'source'),
    target,
    ...(raw['lockfile'] === undefined ? {} : { lockfile: canonical(raw['lockfile'], 'lockfile') }),
  };
}

/** @param raw - The value of the `slots` key */
export function parseSlotsConfig(raw: unknown): SlotsConfig {
  if (!isObject(raw)) throw new ConfigError('Config field "slots" must be an object');
  assertKnownConfigKeys(Object.keys(raw), ['dependencyCaches'], 'slots');
  const caches = raw['dependencyCaches'];
  if (caches === undefined) return {};
  if (!Array.isArray(caches))
    throw new ConfigError('Config field "slots.dependencyCaches" must be an array');
  const parsed = caches.map((entry, index) =>
    parseCache(entry, `slots.dependencyCaches[${String(index)}]`)
  );
  for (const [index, cache] of parsed.entries())
    if (parsed.findIndex((other) => other.target === cache.target) !== index)
      throw new ConfigError(`Config field "slots.dependencyCaches" repeats ${cache.target}`);
  return { dependencyCaches: parsed };
}

/** Paths in a release's object directory, with `*` allowed in the last segment only. */
function releaseOutputs(raw: unknown): string[] {
  const field = 'build.release.outputs';
  if (!Array.isArray(raw) || raw.length === 0)
    throw new ConfigError(`Config field "${field}" must be a non-empty array of paths`);
  for (const entry of raw)
    if (typeof entry !== 'string' || !isCanonicalPath(entry) || posix.dirname(entry).includes('*'))
      throw new ConfigError(
        `Config field "${field}" must hold canonical paths in the object directory, with * only in the last segment: ${String(entry)}`
      );
  return raw as string[];
}

/** @param raw - The value of the `build.release` key */
export function parseBuildRelease(raw: unknown): BuildReleaseConfig {
  if (!isObject(raw)) throw new ConfigError('Config field "build.release" must be an object');
  assertKnownConfigKeys(Object.keys(raw), ['overlay', 'secrets', 'outputs'], 'build.release');
  const secrets = raw['secrets'];
  const outputs = raw['outputs'];
  const release: BuildReleaseConfig = {
    overlay: rootPath(raw['overlay'], 'build.release.overlay'),
    ...(outputs === undefined ? {} : { outputs: releaseOutputs(outputs) }),
  };
  if (secrets === undefined) return release;
  if (!isObject(secrets))
    throw new ConfigError('Config field "build.release.secrets" must be an object');
  assertKnownConfigKeys(Object.keys(secrets), ['variable', 'files'], 'build.release.secrets');
  const variable = secrets['variable'];
  const files = secrets['files'];
  if (typeof variable !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(variable))
    throw new ConfigError('Config field "build.release.secrets.variable" must be a variable name');
  if (
    !Array.isArray(files) ||
    files.some((file) => typeof file !== 'string' || !/^[\w.-]+$/.test(file))
  )
    throw new ConfigError('Config field "build.release.secrets.files" must list file names');
  return { ...release, secrets: { variable, files: files as string[] } };
}
