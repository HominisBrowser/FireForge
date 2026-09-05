// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../errors/base.js';
import { escapeRegex } from '../utils/regex.js';
import type { JarMnToken, MozBuildToken } from './moz-manifest-tokenizers.js';
import { tokenizeJarMn, tokenizeMozBuildList } from './moz-manifest-tokenizers.js';

/**
 * Ordering comparator matching mozbuild's `StrictOrderingOnAppendList`
 * (`mozbuild.util.UnsortedError`): entries are compared case-insensitively,
 * so `HominisAppearanceController` (`appe`) sorts before
 * `HominisAppMenuIntegration` (`appm`) even though a raw byte comparison
 * places the uppercase `M` (0x4D) before the lowercase `e` (0x65).
 *
 * A naive `a > b` insertion landed the new entry in byte order, which
 * `mach configure` then rejected with `UnsortedError`, aborting the build.
 * Ties on the lower-cased key fall back to byte order so the comparison is
 * total and stable.
 */
export function mozbuildSortCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Find alphabetical position within a tokenized jar.mn section. Private:
 * {@link insertJarMnEntry} is the only caller and the only entry point
 * the jar.mn registrars should use.
 */
function findAlphabeticalTokenPosition(
  tokens: JarMnToken[],
  sectionTargetPattern: RegExp,
  newKey: string
): { insertIndex: number; previousEntry: string | undefined } {
  // Find entry tokens in the section matching the pattern
  const sectionEntries = tokens.filter(
    (t) => t.type === 'entry' && t.parsed && sectionTargetPattern.test(t.parsed.target)
  );

  let insertLineIndex: number;
  let previousEntry: string | undefined;

  if (sectionEntries.length === 0) {
    // Empty section: find the section header and insert after it
    const headerToken = tokens.find(
      (t) => t.type === 'header' || (t.type === 'directive' && sectionTargetPattern.test(t.raw))
    );
    if (headerToken) {
      return { insertIndex: headerToken.lineIndex + 1, previousEntry: undefined };
    }
    return { insertIndex: -1, previousEntry: undefined };
  }

  // Default: after the last section entry
  insertLineIndex = (sectionEntries[sectionEntries.length - 1]?.lineIndex ?? 0) + 1;

  for (const entry of sectionEntries) {
    if (!entry.parsed) continue;
    const match = sectionTargetPattern.exec(entry.parsed.target);
    const key = match?.[1] ?? entry.parsed.target;
    if (mozbuildSortCompare(key, newKey) > 0) {
      insertLineIndex = entry.lineIndex;
      break;
    }
    insertLineIndex = entry.lineIndex + 1;
    previousEntry = entry.raw.trim();
  }

  return { insertIndex: insertLineIndex, previousEntry };
}

/**
 * Find alphabetical position within tokenized moz.build list items.
 */
export function findAlphabeticalMozBuildPosition(
  tokens: MozBuildToken[],
  newKey: string
): { insertIndex: number; previousEntry: string | undefined } {
  const items = tokens.filter((t) => t.type === 'list-item');

  if (items.length === 0) {
    // Insert after list-open
    const openToken = tokens.find((t) => t.type === 'list-open');
    return { insertIndex: (openToken?.lineIndex ?? 0) + 1, previousEntry: undefined };
  }

  let insertLineIndex = (items[items.length - 1]?.lineIndex ?? 0) + 1;
  let previousEntry: string | undefined;

  for (const item of items) {
    const key = item.parsed?.value ?? '';
    if (mozbuildSortCompare(key, newKey) > 0) {
      insertLineIndex = item.lineIndex;
      break;
    }
    insertLineIndex = item.lineIndex + 1;
    previousEntry = item.raw.trim();
  }

  return { insertIndex: insertLineIndex, previousEntry };
}

/**
 * Inserts one entry into a tokenized jar.mn / jar.inc.mn, honouring an
 * explicit `--after` anchor and falling back to alphabetical placement when
 * the anchor is not found.
 *
 * Shared by the two jar.mn registrars (browser content, shared CSS), which
 * differ only in the sort pattern, the sort key and the "could not find the
 * section" message, so the anchor-fallback semantics are defined once:
 * silently fall back rather than refuse, and report `afterFallback` so the
 * caller can say so.
 *
 * This helper is jar.mn-specific: the moz.build list form has no `after` anchor
 * and no section concept, so a single generic helper over both families
 * would carry parameters that are meaningless on one side. See
 * {@link insertMozBuildListEntry} for its twin.
 *
 * @param content - Full manifest text
 * @param entry - The already-formatted line to insert
 * @param options - Sort pattern/key, refusal message, and optional anchor
 * @returns The rewritten text plus where it landed and how
 */
export function insertJarMnEntry(
  content: string,
  entry: string,
  options: {
    sortPattern: RegExp;
    sortKey: string;
    missingSectionMessage: string;
    after?: string | undefined;
  }
): {
  result: string;
  insertIndex: number;
  previousEntry: string | undefined;
  afterFallback: boolean;
} {
  const lines = content.split('\n');
  const tokens = tokenizeJarMn(lines);
  let afterFallback = false;

  let insertIndex: number;
  let previousEntry: string | undefined;

  const alphabetical = (): { insertIndex: number; previousEntry: string | undefined } =>
    findAlphabeticalTokenPosition(tokens, options.sortPattern, options.sortKey);

  if (options.after) {
    const afterPattern = new RegExp(`(?:^|/)${escapeRegex(options.after)}(?:\\s|\\)|$)`);
    const afterToken = tokens.find((t) => afterPattern.test(t.raw));
    if (afterToken) {
      insertIndex = afterToken.lineIndex + 1;
      previousEntry = afterToken.raw.trim();
    } else {
      afterFallback = true;
      ({ insertIndex, previousEntry } = alphabetical());
    }
  } else {
    ({ insertIndex, previousEntry } = alphabetical());
  }

  if (insertIndex === -1) {
    throw new GeneralError(options.missingSectionMessage);
  }

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), insertIndex, previousEntry, afterFallback };
}

/**
 * Inserts one entry alphabetically into a moz.build Python list block.
 *
 * Shared by the two moz.build registrars (module list, browser test
 * manifests), which differ only in the list pattern, the sort key and the
 * refusal message.
 *
 * `tokenizeMozBuildList` mutates `lines` in place when it normalizes the
 * single-line `FOO += []` form into the multi-line shape, and that rewrite is
 * what makes the caller's `splice` land inside the list body. The splice
 * below therefore has to run against the same array the tokenizer was
 * handed. A wrapper that tokenized a copy would silently break it.
 *
 * @param content - Full moz.build text
 * @param entry - The already-formatted line to insert
 * @param options - List pattern, sort key, and refusal message
 * @returns The rewritten text and the entry it landed after
 */
export function insertMozBuildListEntry(
  content: string,
  entry: string,
  options: { listPattern: RegExp; sortKey: string; missingListMessage: string }
): { result: string; previousEntry: string | undefined } {
  const lines = content.split('\n');
  const listResult = tokenizeMozBuildList(lines, options.listPattern);

  if (!listResult) {
    throw new GeneralError(options.missingListMessage);
  }

  const { insertIndex, previousEntry } = findAlphabeticalMozBuildPosition(
    listResult.tokens,
    options.sortKey
  );

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry };
}
