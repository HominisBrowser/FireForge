// SPDX-License-Identifier: EUPL-1.2
/**
 * Archive metadata validation and archive identity resolution.
 */

import { ConfigError } from '../errors/config.js';
import type { FirefoxProduct } from '../types/config.js';
import { parseObject } from '../utils/parse.js';
import { isValidFirefoxProduct } from '../utils/validation.js';

/**
 * Resolved archive descriptor for URL generation and cache storage.
 */
export interface ResolvedArchive {
  requestedVersion: string;
  product: FirefoxProduct;
  archiveVersion: string;
  url: string;
  filename: string;
  metadataFilename: string;
}

/**
 * Sidecar metadata stored alongside a cached archive.
 */
export interface ArchiveMetadata {
  requestedVersion: string;
  product: FirefoxProduct;
  archiveVersion: string;
  url: string;
  contentLength?: number | undefined;
  sha256?: string | undefined;
  downloadedAt: string;
}

/**
 * Base URL for Firefox releases on archive.mozilla.org.
 */
const ARCHIVE_BASE_URL = 'https://archive.mozilla.org/pub/firefox/releases';

/**
 * Validates raw JSON data as ArchiveMetadata.
 * @param data - Unknown data to validate
 * @returns Validated ArchiveMetadata
 */
export function validateArchiveMetadata(data: unknown): ArchiveMetadata {
  const rec = parseObject(data, 'Archive metadata');
  const requestedVersion = rec.string('requestedVersion');
  const product = rec.stringEnum(
    'product',
    (v): v is FirefoxProduct => isValidFirefoxProduct(v),
    'a supported Firefox product'
  );
  const archiveVersion = rec.string('archiveVersion');
  const url = rec.string('url');
  const downloadedAt = rec.string('downloadedAt');
  const contentLength = rec.optionalNonNegativeInteger('contentLength');
  const sha256 = rec.optionalString('sha256');

  return {
    requestedVersion,
    product,
    archiveVersion,
    url,
    downloadedAt,
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
  };
}

/**
 * Resolves archive identity for URL generation and cache storage.
 * @param version - Requested Firefox version
 * @param product - Firefox product type
 * @returns Resolved archive descriptor
 */
export function resolveArchive(
  version: string,
  product: FirefoxProduct = 'firefox'
): ResolvedArchive {
  // Reject versions containing path traversal characters
  if (version.includes('/') || version.includes('..') || version.includes('\\')) {
    throw new ConfigError(
      `Invalid Firefox version "${version}": contains disallowed characters`,
      'firefox.version'
    );
  }
  // ESR status is determined solely by the product field. Config validation
  // ensures product and version are consistent, so we never need to infer
  // ESR from the version string independently.
  const cleanVersion = version.replace(/esr$/i, '');
  const isEsr = product === 'firefox-esr';
  const archiveVersion = isEsr ? `${cleanVersion}esr` : cleanVersion;
  const safeProduct = product.replace(/[^a-z0-9-]/gi, '-');

  return {
    requestedVersion: version,
    product,
    archiveVersion,
    url: `${ARCHIVE_BASE_URL}/${archiveVersion}/source/firefox-${archiveVersion}.source.tar.xz`,
    filename: `firefox-${safeProduct}-${archiveVersion}.source.tar.xz`,
    metadataFilename: `firefox-${safeProduct}-${archiveVersion}.source.tar.xz.json`,
  };
}
