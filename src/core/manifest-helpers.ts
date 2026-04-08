// SPDX-License-Identifier: EUPL-1.2
import type { JarMnToken, MozBuildToken } from './manifest-tokenizers.js';

/**
 * Inserts a line into an array of lines in alphabetical order within a
 * specified range. The comparison key is extracted from each line.
 *
 * @returns Object with insertIndex and previousEntry
 */
export function findAlphabeticalPosition(
  lines: string[],
  startLine: number,
  endLine: number,
  newKey: string,
  extractKey: (line: string) => string | undefined
): { insertIndex: number; previousEntry: string | undefined } {
  // Check if existing entries are actually sorted; if not, append at end
  const existingKeys: string[] = [];
  for (let i = startLine; i < endLine; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const key = extractKey(line);
    if (key !== undefined) {
      existingKeys.push(key);
    }
  }

  const isSorted = existingKeys.every(
    (k, idx) => idx === 0 || k.localeCompare(existingKeys[idx - 1] ?? '') >= 0
  );
  if (!isSorted) {
    return { insertIndex: endLine, previousEntry: undefined };
  }

  let insertIndex = endLine;
  let previousEntry: string | undefined;

  for (let i = startLine; i < endLine; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const key = extractKey(line);
    if (key === undefined) continue;

    if (key > newKey) {
      insertIndex = i;
      break;
    }
    insertIndex = i + 1;
    previousEntry = line.trim();
  }

  return { insertIndex, previousEntry };
}

/**
 * Find alphabetical position within a tokenized jar.mn section.
 */
export function findAlphabeticalTokenPosition(
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
    if (key > newKey) {
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
    if (key > newKey) {
      insertLineIndex = item.lineIndex;
      break;
    }
    insertLineIndex = item.lineIndex + 1;
    previousEntry = item.raw.trim();
  }

  return { insertIndex: insertLineIndex, previousEntry };
}
