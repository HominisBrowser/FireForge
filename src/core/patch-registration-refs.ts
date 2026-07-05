// SPDX-License-Identifier: EUPL-1.2
/**
 * Extracts furnace-shaped registration references from a patch body.
 *
 * 2026-04-24 eval Finding 1: `export-all --exclude-furnace` can land a
 * patch that registers a furnace component (via edits to
 * `toolkit/content/customElements.js`, `toolkit/content/jar.mn`, or
 * `toolkit/locales/jar.mn`) without including the component's source
 * files in the patch. `fireforge verify` then reports "Verify clean" for
 * the broken queue. This module provides a pattern-scoped scan so
 * `verify` can cross-check registrations against available file bodies.
 *
 * The scan is deliberately narrow: it only matches component-shaped
 * references (widget tag names, locale fluent names). Unrelated jar.mn
 * or customElements.js edits pass through without spurious warnings.
 */

import { parseDiffSections } from './patch-parse.js';

/** Canonical file paths that registration-shaped diffs touch. */
const REGISTRATION_FILE_PATHS = new Set<string>([
  'toolkit/content/customElements.js',
  'toolkit/content/jar.mn',
  'toolkit/locales/jar.mn',
]);

/**
 * A referenced engine path extracted from a registration hunk, together
 * with where it came from. The `source` field lets `verify` point
 * operators at the specific consequence file whose hunk introduced the
 * reference.
 */
export interface PatchRegistrationReference {
  /** Engine-relative path that the registration hunk adds a reference to. */
  targetPath: string;
  /** The registration file that contained the added hunk. */
  source: string;
  /** Raw hunk line that produced the reference, for diagnostic context. */
  lineText: string;
}

/**
 * Walks a unified-diff patch body and returns the set of
 * component-shaped engine paths that the patch ADDS a registration for.
 *
 * Returns the empty array when no registration hunks are present OR
 * when the registration hunks do not mention any component-shaped
 * paths — that leaves the scan silent on the vast majority of patches
 * (branding tweaks, behavioural fixes, module additions) so it only
 * fires when a furnace-managed component is being newly registered.
 *
 * @param patchBody - Full unified-diff body of the patch file.
 */
export function collectPatchRegistrationReferences(
  patchBody: string
): PatchRegistrationReference[] {
  if (!patchBody) return [];

  const refs: PatchRegistrationReference[] = [];

  // Key the file state off the `b/` path because that names the target
  // side and is stable against renames. Only real hunk adds count —
  // parseDiffSections has already filtered out header/metadata lines.
  for (const section of parseDiffSections(patchBody)) {
    if (!REGISTRATION_FILE_PATHS.has(section.targetPath)) continue;
    for (const hunk of section.hunks) {
      for (const line of hunk.lines) {
        if (!line.startsWith('+')) continue;
        const added = line.slice(1);
        const extracted = extractTargetPathsFromRegistrationLine(section.targetPath, added);
        for (const target of extracted) {
          refs.push({ targetPath: target, source: section.targetPath, lineText: added });
        }
      }
    }
  }

  return refs;
}

/**
 * Per-source extractor. Each registration file has a distinct syntactic
 * shape; we scope the match to that file so a jar.mn regex does not
 * accidentally match a customElements.js line.
 */
function extractTargetPathsFromRegistrationLine(sourceFile: string, added: string): string[] {
  if (sourceFile === 'toolkit/content/jar.mn') {
    // Example (added line, leading `+` already stripped):
    //   `   content/global/elements/moz-qa-panel.mjs  (widgets/moz-qa-panel/moz-qa-panel.mjs)`
    // The parenthesised second half is the repo-relative path Firefox's
    // packaging system reads. Widget registrations always live under
    // `widgets/<tag>/<file>` — the enclosing tree is
    // `toolkit/content/widgets/`. Reconstruct the engine-relative
    // target path so callers can check it against patch bodies.
    const widgetMatch = /\(\s*(widgets\/[^\s)]+)\s*\)/.exec(added);
    if (widgetMatch?.[1]) {
      return [`toolkit/content/${widgetMatch[1]}`];
    }
    return [];
  }

  if (sourceFile === 'toolkit/locales/jar.mn') {
    // Example:
    //   `  locale/@AB_CD@/toolkit/global/moz-qa-panel.ftl (%toolkit/global/moz-qa-panel.ftl)`
    // The `%`-prefixed repo-relative reference points at
    // `toolkit/locales/en-US/<rel>`, which is the canonical FTL path.
    const localeMatch = /\(%\s*([^\s)]+\.ftl)\s*\)/.exec(added);
    if (localeMatch?.[1]) {
      return [`toolkit/locales/en-US/${localeMatch[1]}`];
    }
    return [];
  }

  if (sourceFile === 'toolkit/content/customElements.js') {
    // Example:
    //   `          ["moz-qa-panel", "chrome://global/content/elements/moz-qa-panel.mjs"],`
    // The chrome URL maps back to
    // `toolkit/content/widgets/<tag>/<tag>.mjs` by convention: the
    // packager rewrites `chrome://global/content/elements/<file>` to the
    // widget tree root. The tag name is the identifier we key off.
    const elementMatch =
      /\[\s*"([a-z][a-z0-9-]*)"\s*,\s*"chrome:\/\/global\/content\/elements\/([a-zA-Z0-9_-]+)\.mjs"\s*\]/.exec(
        added
      );
    if (elementMatch?.[1] && elementMatch[2]) {
      const tag = elementMatch[1];
      const fileStem = elementMatch[2];
      return [`toolkit/content/widgets/${tag}/${fileStem}.mjs`];
    }
    return [];
  }

  return [];
}
