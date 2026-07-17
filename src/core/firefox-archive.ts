// SPDX-License-Identifier: EUPL-1.2
/**
 * Archive metadata validation and archive identity resolution.
 */

import { ConfigError } from '../errors/config.js';
import type { FirefoxProduct } from '../types/config.js';
import { parseObject } from '../utils/parse.js';
import { isValidFirefoxCandidate, isValidFirefoxProduct } from '../utils/validation.js';

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
  /** URL of Mozilla's published SHA256SUMS file for the release. */
  checksumsUrl: string;
  /** The archive's path as listed inside SHA256SUMS (relative to the release dir). */
  pathInChecksums: string;
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
 * Base URLs for Firefox source archives on archive.mozilla.org.
 */
const FIREFOX_ARCHIVE_BASE_URL = 'https://archive.mozilla.org/pub/firefox';
const DEVEDITION_ARCHIVE_BASE_URL = 'https://archive.mozilla.org/pub/devedition';

function getArchiveBaseUrl(product: FirefoxProduct): string {
  return product === 'firefox-devedition' ? DEVEDITION_ARCHIVE_BASE_URL : FIREFOX_ARCHIVE_BASE_URL;
}

/**
 * Directory holding the release's artifacts: `releases/<version>/` for
 * final releases, `candidates/<version>-candidates/<buildN>/` when a
 * release-candidate build is requested for pre-release verification.
 */
function getArchiveDirUrl(
  product: FirefoxProduct,
  archiveVersion: string,
  candidate?: string
): string {
  const base = getArchiveBaseUrl(product);
  return candidate === undefined
    ? `${base}/releases/${archiveVersion}`
    : `${base}/candidates/${archiveVersion}-candidates/${candidate}`;
}

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
 * @param candidate - Optional release-candidate build directory (e.g. "build2")
 * @returns Resolved archive descriptor
 */
export function resolveArchive(
  version: string,
  product: FirefoxProduct = 'firefox',
  candidate?: string
): ResolvedArchive {
  // Reject versions containing path traversal characters
  if (version.includes('/') || version.includes('..') || version.includes('\\')) {
    throw new ConfigError(
      `Invalid Firefox version "${version}": contains disallowed characters`,
      'firefox.version'
    );
  }
  // Defense-in-depth: config validation enforces this shape already, but a
  // caller-supplied candidate becomes both a URL path segment and part of
  // the cache filename, so re-validate here like the version check above.
  if (candidate !== undefined && !isValidFirefoxCandidate(candidate)) {
    throw new ConfigError(
      `Invalid Firefox candidate "${candidate}": must look like "buildN" (e.g. "build2")`,
      'firefox.candidate'
    );
  }
  // ESR status is determined solely by the product field. Config validation
  // ensures product and version are consistent, so we never need to infer
  // ESR from the version string independently.
  const cleanVersion = version.replace(/esr$/i, '');
  const isEsr = product === 'firefox-esr';
  const archiveVersion = isEsr ? `${cleanVersion}esr` : cleanVersion;
  const safeProduct = product.replace(/[^a-z0-9-]/gi, '-');
  const dirUrl = getArchiveDirUrl(product, archiveVersion, candidate);
  // Candidate artifacts get a `-<candidate>` filename suffix so a build2
  // archive can never collide with the final release artifact (same
  // archiveVersion, potentially different bytes) in .fireforge/cache.
  const candidateSuffix = candidate === undefined ? '' : `-${candidate}`;
  const filename = `firefox-${safeProduct}-${archiveVersion}${candidateSuffix}.source.tar.xz`;

  return {
    requestedVersion: version,
    product,
    archiveVersion,
    url: `${dirUrl}/source/firefox-${archiveVersion}.source.tar.xz`,
    filename,
    metadataFilename: `${filename}.json`,
    // Mozilla publishes one SHA256SUMS per release directory listing every
    // artifact by its release-relative path. Downloads verify against it by
    // default (fail closed on mismatch), so a compromised CDN response
    // cannot silently become the trusted git baseline.
    checksumsUrl: `${dirUrl}/SHA256SUMS`,
    pathInChecksums: `source/firefox-${archiveVersion}.source.tar.xz`,
  };
}
