// SPDX-License-Identifier: EUPL-1.2
import type { PatchMetadata } from '../types/commands/index.js';
import type { FirefoxConfig } from '../types/config.js';

/** Metadata fields stamped on new or refreshed patch entries. */
export function buildPatchSourceMetadata(
  firefox: Pick<FirefoxConfig, 'product' | 'version'>
): Pick<PatchMetadata, 'sourceEsrVersion' | 'sourceProduct' | 'sourceVersion'> {
  return {
    sourceEsrVersion: firefox.version,
    sourceProduct: firefox.product,
    sourceVersion: firefox.version,
  };
}

/** Backward-compatible source version reader for legacy manifests. */
export function getPatchSourceVersion(
  patch: Pick<PatchMetadata, 'sourceEsrVersion' | 'sourceVersion'>
): string {
  return patch.sourceVersion ?? patch.sourceEsrVersion;
}
