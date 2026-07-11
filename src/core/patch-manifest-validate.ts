// SPDX-License-Identifier: EUPL-1.2
/**
 * Schema validation for patches.json manifest data.
 */

import type {
  PatchCategory,
  PatchesManifest,
  PatchMetadata,
  PatchStagedDependencies,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../types/commands/index.js';
import type { FirefoxProduct } from '../types/config.js';
import { parseObject } from '../utils/parse.js';
import {
  isArray,
  isObject,
  isValidFirefoxProduct,
  isValidFirefoxVersion,
  PATCH_CATEGORIES,
} from '../utils/validation.js';

function parseForwardImports(data: unknown, label: string): PatchStagedForwardImport[] {
  if (!isArray(data)) {
    throw new Error(`${label} must be an array`);
  }
  return data.map((entry, index) => {
    const rec = parseObject(entry, `${label}[${index}]`);
    const dependency: PatchStagedForwardImport = {
      file: rec.string('file'),
      specifier: rec.string('specifier'),
      creates: rec.string('creates'),
    };
    const owner = rec.optionalString('owner');
    if (owner !== undefined) dependency.owner = owner;
    const reason = rec.optionalString('reason');
    if (reason !== undefined) dependency.reason = reason;
    return dependency;
  });
}

function parseRegistrations(data: unknown, label: string): PatchStagedRegistration[] {
  if (!isArray(data)) {
    throw new Error(`${label} must be an array`);
  }
  return data.map((entry, index) => {
    const rec = parseObject(entry, `${label}[${index}]`);
    const dependency: PatchStagedRegistration = {
      file: rec.string('file'),
      line: rec.string('line'),
      creates: rec.string('creates'),
    };
    const owner = rec.optionalString('owner');
    if (owner !== undefined) dependency.owner = owner;
    const reason = rec.optionalString('reason');
    if (reason !== undefined) dependency.reason = reason;
    return dependency;
  });
}

function parseStagedDependencies(data: unknown, label: string): PatchStagedDependencies {
  const rec = parseObject(data, label);
  const rawForwardImports = rec.raw('forwardImports');
  const rawRegistrations = rec.raw('registrations');
  const staged: PatchStagedDependencies = {};
  if (rawForwardImports !== undefined) {
    staged.forwardImports = parseForwardImports(rawForwardImports, `${label}.forwardImports`);
  }
  if (rawRegistrations !== undefined) {
    staged.registrations = parseRegistrations(rawRegistrations, `${label}.registrations`);
  }
  return staged;
}

/**
 * Validates a single patch metadata entry from raw data.
 * @param data - Raw data to validate
 * @param index - Array index for error messages
 * @returns Validated PatchMetadata
 */
function validatePatchMetadata(data: unknown, index: number): PatchMetadata {
  const rec = parseObject(data, `patches[${index}]`);

  const filename = rec.string('filename');
  const name = rec.string('name');
  const description = rec.string('description');
  const createdAt = rec.string('createdAt');
  const sourceEsrVersion = rec.optionalString('sourceEsrVersion');
  const sourceVersion = rec.optionalString('sourceVersion') ?? sourceEsrVersion;
  if (sourceVersion === undefined) {
    throw new Error(`patches[${index}] must include sourceVersion or legacy sourceEsrVersion`);
  }
  const sourceProductRaw = rec.optionalString('sourceProduct');
  let sourceProduct: FirefoxProduct | undefined;
  if (sourceProductRaw !== undefined) {
    if (!isValidFirefoxProduct(sourceProductRaw)) {
      throw new Error(
        `patches[${index}].sourceProduct must be one of: firefox, firefox-esr, firefox-beta, firefox-devedition`
      );
    }
    sourceProduct = sourceProductRaw as FirefoxProduct;
  }
  const order = rec.nonNegativeInteger('order');
  const category = rec.validatedString(
    'category',
    (value) => /^[a-z][a-z0-9-]*$/.test(value),
    'a lowercase category identifier (letters, numbers, hyphens)'
  );

  if (!isValidFirefoxVersion(sourceVersion)) {
    throw new Error(`patches[${index}].sourceVersion must be a valid Firefox version string`);
  }
  if (sourceEsrVersion !== undefined && !isValidFirefoxVersion(sourceEsrVersion)) {
    throw new Error(`patches[${index}].sourceEsrVersion must be a valid Firefox version string`);
  }

  const filesAffected = rec.stringArray('filesAffected');

  // Optional fields. These were silently stripped before the 0.17.0
  // branding-tier work reached in and audited the loader — the 0.16.0
  // `lintIgnore` escape hatch demonstrably round-tripped only through
  // test fixtures that mocked `loadPatchesManifest` directly. Real
  // operator edits to `patches.json` were dropped on every subsequent
  // load, so any patch that relied on `lintIgnore` to suppress a
  // specific lint rule was quietly re-tripped the next time the
  // manifest validated. Preserve both the pre-existing `lintIgnore`
  // and the new `tier` field here so future-added optional fields
  // have a ready template to follow.
  const lintIgnore = rec.optionalStringArray('lintIgnore');

  const rawTier = rec.raw('tier');
  let tier: 'branding' | undefined;
  if (rawTier !== undefined) {
    if (rawTier !== 'branding') {
      throw new Error(
        `patches[${index}].tier must be "branding" when present (unknown tier values are rejected, not silently ignored).`
      );
    }
    tier = 'branding';
  }

  const result: PatchMetadata = {
    filename,
    order,
    category,
    name,
    description,
    createdAt,
    sourceEsrVersion: sourceEsrVersion ?? sourceVersion,
    sourceVersion,
    filesAffected,
  };
  if (sourceProduct !== undefined) result.sourceProduct = sourceProduct;
  if (lintIgnore !== undefined) result.lintIgnore = lintIgnore;
  if (tier !== undefined) result.tier = tier;
  const rawStagedDependencies = rec.raw('stagedDependencies');
  if (rawStagedDependencies !== undefined) {
    result.stagedDependencies = parseStagedDependencies(
      rawStagedDependencies,
      `patches[${index}].stagedDependencies`
    );
  }
  return result;
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
    const category = categorizedMatch[2];
    if ((PATCH_CATEGORIES as readonly string[]).includes(category)) {
      return { category, name: categorizedMatch[3] };
    }
  }

  const legacyMatch = /^(\d+)-(.+)\.patch$/.exec(filename);
  if (legacyMatch?.[2]) {
    return { category: 'infra', name: legacyMatch[2] };
  }

  return { category: 'infra', name: filename.replace(/\.patch$/, '') };
}
