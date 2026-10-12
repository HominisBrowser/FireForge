// SPDX-License-Identifier: EUPL-1.2
/**
 * The `--patches <name…>` subset resolver shared by `lint --per-patch`,
 * `status` and `verify`. One matcher, so a name that selects a patch in
 * one gate selects the same patch in the others.
 */
import { GeneralError } from '../errors/base.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';

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
 * values and comma lists. Throws listing the available patches when a
 * requested name matches none, so a typo fails loud rather than silently
 * judging nothing.
 *
 * @param manifest - The loaded patch manifest
 * @param requested - Raw `--patches` values (each may be a comma list)
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
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const selected: PatchMetadata[] = [];
  const seen = new Set<string>();
  for (const name of normalizedRequests) {
    const found = manifest.patches.filter((p) => matchesPatch(p, name));
    if (found.length === 0) {
      const available = manifest.patches.map((p) => p.filename).join(', ');
      throw new GeneralError(
        `No patch in the queue matches "${name}".${refusalHint ? ` ${refusalHint}` : ''} ` +
          `Available patches: ${available}`
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
