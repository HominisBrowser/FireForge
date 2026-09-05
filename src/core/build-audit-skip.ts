// SPDX-License-Identifier: EUPL-1.2
/**
 * Skip classification for the post-build packaging audit.
 *
 * The audit is warn-only, which makes a false positive cheap individually
 * and expensive in aggregate: an operator who learns that `Audit:` lines are
 * usually wrong stops reading the one that is right. Every classifier here
 * exists to remove a warning whose "missing packaged artifact" claim is
 * structurally impossible, and each carries its own reason so the
 * `Packaged:` summary can say what it skipped and why — a run reporting
 * `4 missing` with zero real misses is what this replaces.
 */
import { readText } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';
import { extractWithBrandingPath } from './mach-mozconfig.js';

/**
 * Why a changed engine path was not audited.
 *
 * The first four name skips that already existed as unstructured
 * `verbose()` strings; the last four are the 0.46.0 classifiers.
 */
export type AuditSkipReason =
  | 'not-packageable'
  | 'platform-gated'
  | 'platform-gated-ancestor'
  | 'tests-not-packaged'
  | 'source-unreadable'
  | 'branding-not-selected'
  | 'storybook-story'
  | 'declared-unpackaged';

/** Render order for the `Packaged:` summary's per-class breakdown. */
export const AUDIT_SKIP_REASONS: readonly AuditSkipReason[] = [
  'not-packageable',
  'platform-gated',
  'platform-gated-ancestor',
  'tests-not-packaged',
  'source-unreadable',
  'branding-not-selected',
  'storybook-story',
  'declared-unpackaged',
];

/**
 * Suffixes of Storybook story modules.
 *
 * Firefox's in-tree Storybook renders these through its own Vite config;
 * no `jar.mn` or `moz.build` entry packages one, so "no packaged artifact"
 * is the expected state rather than a missing registration. Kept as a
 * CLOSED list on purpose: generalising to "anything with a dotted infix"
 * would swallow `*.worker.js` and `*.sys.mjs`, which are packaged.
 */
const STORYBOOK_SUFFIXES = ['.stories.mjs', '.stories.js'];

/** True for a Storybook story module. */
export function isStorybookStoryPath(sourcePath: string): boolean {
  const normalised = normalizePathSlashes(sourcePath);
  return STORYBOOK_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/** Prefix under which every branding tree lives. */
const BRANDING_ROOT = 'browser/branding/';

/**
 * Reads the branding directory this objdir was configured with.
 *
 * FireForge generates `engine/mozconfig` and writes the
 * `ac_add_options --with-branding=…` line into it, so the selected branding
 * is knowable from the tree. Returns undefined when the mozconfig cannot be
 * read or carries no directive — the caller must then keep warning, because
 * a skip that cannot name its evidence is a masked warning.
 *
 * @param engineDir - Absolute path to the engine root
 * @returns Engine-relative branding path, or undefined
 */
export async function resolveSelectedBranding(engineDir: string): Promise<string | undefined> {
  try {
    const content = await readText(`${engineDir.replace(/[/\\]+$/, '')}/mozconfig`);
    const selected = extractWithBrandingPath(content);
    return selected === undefined ? undefined : normalizePathSlashes(selected).replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * True when `sourcePath` lives under a branding tree that is NOT the one
 * this objdir was configured with.
 *
 * An unselected branding directory is not an input to this build at all, so
 * its files can never appear in `dist/`. Worse, the basename walker matched
 * them against the SELECTED branding's same-named artifact and reported the
 * unselected file as "newer than its packaged artifact" — a stale warning
 * about a comparison that has no meaning.
 *
 * @param sourcePath - Engine-relative POSIX path
 * @param selectedBranding - Engine-relative selected branding path
 */
export function isUnselectedBrandingPath(
  sourcePath: string,
  selectedBranding: string | undefined
): boolean {
  if (selectedBranding === undefined) return false;
  const normalised = normalizePathSlashes(sourcePath);
  if (!normalised.startsWith(BRANDING_ROOT)) return false;
  const selected = `${selectedBranding}/`;
  return !normalised.startsWith(selected);
}

/** One `buildAudit.unpackaged` carve-out from `fireforge.json`. */
export interface UnpackagedDeclaration {
  /** Engine-relative path or glob. */
  path: string;
  /** Why this file is deliberately never packaged. Required, non-empty. */
  reason: string;
}

/**
 * Finds the declaration admitting `sourcePath`, if any.
 *
 * Exact match or a `*`-within-one-segment glob, matching the
 * `support-files` matcher's deliberate narrowness: `**` and other
 * cross-directory shapes are not accepted, because a carve-out that
 * silently widens is exactly the failure this feature is warned against.
 *
 * @param sourcePath - Engine-relative POSIX path
 * @param declarations - The project's `buildAudit.unpackaged` entries
 */
export function matchUnpackagedDeclaration(
  sourcePath: string,
  declarations: readonly UnpackagedDeclaration[]
): UnpackagedDeclaration | undefined {
  const normalised = normalizePathSlashes(sourcePath);
  return declarations.find((declaration) => {
    const pattern = normalizePathSlashes(declaration.path);
    if (!pattern.includes('*')) return pattern === normalised;
    const regex = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => escapeRegex(part))
        .join('[^/]*')}$`
    );
    return regex.test(normalised);
  });
}
