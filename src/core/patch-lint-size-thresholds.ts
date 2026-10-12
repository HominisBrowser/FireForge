// SPDX-License-Identifier: EUPL-1.2
/**
 * The patch-size thresholds (`large-patch-lines`, `large-patch-files`) and
 * their merge with `patchLint.patchSizeThresholds`.
 *
 * Its own dependency-free module for the same reason as
 * `patch-lint-file-size.ts`: the config validator checks an override
 * against the merged result, and importing the rule bodies from config
 * parsing would draw an import cycle.
 */

import type { PatchLintFileSizeTier, PatchLintPatchSizeThresholds } from '../types/config.js';
import { escapeRegex } from '../utils/regex.js';
import type { ResolvedFileSizeTier } from './patch-lint-file-size.js';

/** The tiers a patch is measured against. */
export type PatchSizeTierName = 'general' | 'test' | 'branding';

/**
 * Built-in line-count bands per tier.
 *
 * Branding patches have a legitimate reason to be large: they include
 * every locale's `brand.ftl`, copied upstream CSS/PNG assets, and the
 * fork-specific `configure.sh` / `brand.properties` under a single
 * `browser/branding/<name>/` subtree. The tier is calibrated against a
 * fresh-fork branding export, which lands around 15-16k lines (localized
 * brand.ftl across many locales + SVG path data + copied upstream CSS).
 * That is the minimum branding diff, so it must surface as a `notice`
 * rather than a `warning`: the warning band sits above it with ~13%
 * headroom, and the error band at roughly 2× the baseline, where
 * non-branding work is probably bundled in.
 *
 * Permissive thresholds are safe because the *gate* into this tier is
 * narrow: auto-detect requires every file under `browser/branding/` plus a
 * tight registration allowlist, or an explicit `PatchMetadata.tier:
 * "branding"` opt-in. A non-branding patch cannot accidentally land here.
 */
const DEFAULT_PATCH_LINE_THRESHOLDS: Readonly<Record<PatchSizeTierName, ResolvedFileSizeTier>> = {
  general: { notice: 800, warning: 1500, error: 3000 },
  test: { notice: 1500, warning: 3000, error: 6000 },
  branding: { notice: 8000, warning: 18000, error: 30000 },
};

/**
 * Built-in `large-patch-files` warning band per tier. There is no notice or
 * error band by default: file count expresses scope, not blast radius.
 *
 * The branding tier sits well above the typical floor because branding
 * patches inherently span many files: PNG/ICO icon assets in 7+ sizes, MSIX
 * manifests, channel-specific configs, locale `.ftl` files, Windows/macOS
 * launcher resources. A fresh-fork branding bundle is around 56 files, so 60
 * leaves headroom for additional channels/locales while still firing on a
 * genuinely bloated patch. The test tier matches general because a
 * test-only patch rarely touches many files.
 */
const DEFAULT_PATCH_FILES_WARNING: Readonly<Record<PatchSizeTierName, number>> = {
  general: 5,
  test: 5,
  branding: 60,
};

/**
 * A resolved `large-patch-files` triple. `error` is `null` when no error
 * band is configured. `notice` equal to `warning` means no notice band.
 */
export interface ResolvedPatchFilesTier {
  notice: number;
  warning: number;
  error: number | null;
}

/** Line and file-count thresholds governing one patch-size tier. */
export interface PatchSizeThresholds {
  /** Line counts at which `large-patch-lines` notice/warning/error issues fire. */
  lines: ResolvedFileSizeTier;
  /** File counts at which `large-patch-files` notice/warning/error issues fire. */
  files: ResolvedPatchFilesTier;
  /**
   * The `files.warning` threshold, kept for consumers written before the
   * files triple existed.
   */
  maxFiles: number;
}

/**
 * Merges the configured overrides over the defaults for one tier.
 *
 * @param tier - The tier to resolve
 * @param overrides - The `patchLint.patchSizeThresholds` block, if any
 * @returns The effective thresholds
 */
export function resolvePatchSizeThresholds(
  tier: PatchSizeTierName,
  overrides: PatchLintPatchSizeThresholds | undefined
): PatchSizeThresholds {
  const configured = overrides?.[tier];
  const lines = { ...DEFAULT_PATCH_LINE_THRESHOLDS[tier], ...configured?.lines };
  const files = resolveFilesTier(DEFAULT_PATCH_FILES_WARNING[tier], configured?.files);
  return { lines, files, maxFiles: files.warning };
}

function resolveFilesTier(
  defaultWarning: number,
  configured: PatchLintFileSizeTier | undefined
): ResolvedPatchFilesTier {
  const warning = configured?.warning ?? defaultWarning;
  return {
    notice: configured?.notice ?? warning,
    warning,
    error: configured?.error ?? null,
  };
}

/**
 * True when `file` matches one of the `patchLint.patchSizeRegistrationFiles`
 * globs. A glob without `/` matches the basename, one with `/` the whole
 * engine-relative path. `*` and `?` stay within a segment, `**` crosses
 * segments.
 *
 * @param file - Engine-relative POSIX path
 * @param globs - The configured globs
 */
export function isPatchSizeRegistrationFile(file: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const basename = file.slice(file.lastIndexOf('/') + 1);
  return globs.some((glob) => globToRegExp(glob).test(glob.includes('/') ? file : basename));
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '*' && glob.charAt(i + 1) === '*') {
      // `**/` matches zero or more whole segments, a bare `**` anything.
      const slash = glob.charAt(i + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}
