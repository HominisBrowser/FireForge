// SPDX-License-Identifier: EUPL-1.2
/**
 * Schema validation for patches.json manifest data.
 */

import type { PatchCategory, PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { parseObject } from '../utils/parse.js';
import {
  isArray,
  isObject,
  isValidFirefoxVersion,
  isValidPatchCategory,
  PATCH_CATEGORIES,
} from '../utils/validation.js';

/**
 * Validates a single patch metadata entry from raw data.
 * @param data - Raw data to validate
 * @param index - Array index for error messages
 * @returns Validated PatchMetadata
 */
export function validatePatchMetadata(data: unknown, index: number): PatchMetadata {
  const rec = parseObject(data, `patches[${index}]`);

  const filename = rec.string('filename');
  const name = rec.string('name');
  const description = rec.string('description');
  const createdAt = rec.string('createdAt');
  const sourceEsrVersion = rec.string('sourceEsrVersion');
  const order = rec.nonNegativeInteger('order');
  const category = rec.stringEnum(
    'category',
    (v): v is PatchCategory => isValidPatchCategory(v),
    `one of: ${PATCH_CATEGORIES.join(', ')}`
  );

  if (!isValidFirefoxVersion(sourceEsrVersion)) {
    throw new Error(`patches[${index}].sourceEsrVersion must be a valid Firefox version string`);
  }

  const filesAffected = rec.stringArray('filesAffected');

  return {
    filename,
    order,
    category,
    name,
    description,
    createdAt,
    sourceEsrVersion,
    filesAffected,
  };
}

/** Validates raw patches.json data and returns the typed manifest shape. */
export function validatePatchesManifest(data: unknown): PatchesManifest {
  if (!isObject(data)) {
    throw new Error('patches.json must be a JSON object');
  }

  if (data['version'] !== 1) {
    throw new Error('patches.json version must be 1');
  }

  if (!isArray(data['patches'])) {
    throw new Error('patches.json field "patches" must be an array');
  }

  return {
    version: 1,
    patches: data['patches'].map((patch, index) => validatePatchMetadata(patch, index)),
  };
}

/**
 * Infers patch metadata from a filename pattern.
 * @param filename - Patch filename (e.g. "001-ui-toolbar.patch")
 * @returns Inferred category and name
 */
export function inferPatchMetadataFromFilename(filename: string): {
  category: PatchCategory;
  name: string;
} {
  const categorizedMatch = /^(\d+)-([a-z]+)-(.+)\.patch$/.exec(filename);
  if (categorizedMatch?.[2] && categorizedMatch[3]) {
    const category = categorizedMatch[2] as PatchCategory;
    if (PATCH_CATEGORIES.includes(category)) {
      return { category, name: categorizedMatch[3] };
    }
  }

  const legacyMatch = /^(\d+)-(.+)\.patch$/.exec(filename);
  if (legacyMatch?.[2]) {
    return { category: 'infra', name: legacyMatch[2] };
  }

  return { category: 'infra', name: filename.replace(/\.patch$/, '') };
}
