// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for the `exportQueue` block: how `authored export-queue` groups
 * the files a project created into patches.
 */
import { ConfigError } from '../errors/config.js';
import type { ExportQueueConfig, ExportQueueGroup } from '../types/config.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';

/** A group name is a patch name: lowercase words joined by hyphens. */
const GROUP_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function parseGroup(raw: unknown, field: string): ExportQueueGroup {
  if (!isObject(raw)) {
    throw new ConfigError(`Config field "${field}" must be an object with "name" and "paths"`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'name' && key !== 'paths') {
      throw new ConfigError(`Config field "${field}" has unknown key "${key}"`);
    }
  }
  const name = raw['name'];
  if (typeof name !== 'string' || !GROUP_NAME.test(name)) {
    throw new ConfigError(
      `Config field "${field}.name" must be lowercase words joined by hyphens (e.g. "ui-sidebar")`
    );
  }
  const paths = raw['paths'];
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ConfigError(`Config field "${field}.paths" must be a non-empty array of globs`);
  }
  for (const [index, path] of paths.entries()) {
    if (typeof path !== 'string' || path.trim() === '' || !isContainedRelativePath(path)) {
      throw new ConfigError(
        `Config field "${field}.paths[${String(index)}]" must be an engine-relative glob`
      );
    }
  }
  return { name, paths: paths as string[] };
}

/**
 * Parses the `exportQueue` block.
 *
 * @param raw - The raw `exportQueue` value from fireforge.json
 * @returns The validated block
 */
export function parseExportQueueConfig(raw: unknown): ExportQueueConfig {
  if (!isObject(raw)) {
    throw new ConfigError('Config field "exportQueue" must be a plain object');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'groups' && key !== 'maxGroupBytes') {
      throw new ConfigError(`Config field "exportQueue" has unknown key "${key}"`);
    }
  }
  const config: ExportQueueConfig = {};
  const groups = raw['groups'];
  if (groups !== undefined) {
    if (!Array.isArray(groups)) {
      throw new ConfigError('Config field "exportQueue.groups" must be an array');
    }
    config.groups = groups.map((group, index) =>
      parseGroup(group, `exportQueue.groups[${String(index)}]`)
    );
    const seen = new Set<string>();
    for (const group of config.groups) {
      if (seen.has(group.name)) {
        throw new ConfigError(
          `Config field "exportQueue.groups" names "${group.name}" more than once`
        );
      }
      seen.add(group.name);
    }
  }
  const maxGroupBytes = raw['maxGroupBytes'];
  if (maxGroupBytes !== undefined) {
    if (
      typeof maxGroupBytes !== 'number' ||
      !Number.isSafeInteger(maxGroupBytes) ||
      maxGroupBytes < 1
    ) {
      throw new ConfigError('Config field "exportQueue.maxGroupBytes" must be a positive integer');
    }
    config.maxGroupBytes = maxGroupBytes;
  }
  return config;
}
