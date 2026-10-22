// SPDX-License-Identifier: EUPL-1.2
/**
 * The `--patches <name…>` subset resolver shared by `lint --per-patch`,
 * `status` and `verify`. One matcher, so a name that selects a patch in
 * one gate selects the same patch in the others.
 */
import { GeneralError } from '../errors/base.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import { formatPatchSuggestions } from './patch-identifier-suggest.js';

/** Every spelling an operator may use for one patch. */
function patchAliases(p: PatchMetadata): Set<string> {
  const aliases = new Set<string>([p.filename, p.filename.replace(/\.patch$/, ''), p.name]);
  // The bare order number, both as the manifest records it and as the
  // filename spells it (`2` and `002`). The refusal message offers stems,
  // and an operator reading `102-ui-canvas-tiles.patch` in a lint finding
  // reaches for `102` first.
  aliases.add(String(p.order));
  const match = /^(\d+)-([a-z]+)-(.+)\.patch$/.exec(p.filename);
  if (match?.[1]) aliases.add(match[1]);
  if (match?.[2] && match[3]) {
    aliases.add(`${match[2]}-${match[3]}`);
    aliases.add(match[3]);
  }
  return aliases;
}

function matchesPatch(p: PatchMetadata, name: string): boolean {
  const aliases = patchAliases(p);
  const stem = name.replace(/\.patch$/, '');
  return aliases.has(name) || aliases.has(stem) || aliases.has(`${stem}.patch`);
}

/**
 * Resolves a `--patches <name…>` subset against the manifest, matching each
 * requested name tolerantly (exact filename, filename ± `.patch`, the bare
 * order number, the manifest `name` field, or the slug). Accepts repeated
 * values and lists separated by commas or whitespace, so a list passed as
 * one shell word (`--patches "$P"` under zsh) still splits. Throws when a
 * requested name matches none, so a typo fails loud rather than silently
 * judging nothing; the refusal names that name and its nearest matches,
 * not the whole queue.
 *
 * @param manifest - The loaded patch manifest
 * @param requested - Raw `--patches` values (each may be a comma or whitespace list)
 * @param refusalHint - Sentence inserted into the no-match refusal, naming
 *   what the caller's flag selects
 * @returns The matching manifest rows, de-duplicated, in request order
 */
export function selectPatchSubset(
  manifest: PatchesManifest,
  requested: readonly string[],
  refusalHint = ''
): PatchMetadata[] {
  const normalizedRequests = requested
    .flatMap((entry) => entry.split(/[\s,]+/))
    .filter((entry) => entry.length > 0);

  const selected: PatchMetadata[] = [];
  const seen = new Set<string>();
  for (const name of normalizedRequests) {
    const found = manifest.patches.filter((p) => matchesPatch(p, name));
    if (found.length === 0) {
      throw new GeneralError(
        `No patch in the queue matches "${name}".${refusalHint ? ` ${refusalHint}` : ''} ` +
          formatPatchSuggestions(name, manifest.patches)
      );
    }
    for (const p of found) {
      if (!seen.has(p.filename)) {
        seen.add(p.filename);
        selected.push(p);
      }
    }
  }
  return selected;
}
