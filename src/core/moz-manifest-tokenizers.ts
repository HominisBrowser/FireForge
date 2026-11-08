// SPDX-License-Identifier: EUPL-1.2
/** Token for jar.mn / jar.inc.mn files */
export interface JarMnToken {
  type: 'header' | 'directive' | 'entry' | 'empty' | 'comment';
  raw: string;
  lineIndex: number;
  parsed?: { target: string; source: string } | undefined;
}

/** Token for moz.build Python-style list blocks */
export interface MozBuildToken {
  type: 'list-open' | 'list-item' | 'list-close' | 'other';
  raw: string;
  lineIndex: number;
  parsed?: { value: string } | undefined;
}

/**
 * Tokenizes a jar.mn file into structured tokens.
 * Recognizes headers, `%` directives, entries with (source) paths,
 * comments, and blank lines.
 */
export function tokenizeJarMn(lines: string[]): JarMnToken[] {
  const tokens: JarMnToken[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    if (trimmed === '') {
      tokens.push({ type: 'empty', raw, lineIndex: i });
      continue;
    }

    if (trimmed.startsWith('#')) {
      tokens.push({ type: 'comment', raw, lineIndex: i });
      continue;
    }

    if (trimmed.startsWith('%')) {
      tokens.push({ type: 'directive', raw, lineIndex: i });
      continue;
    }

    // Entries with source paths: "  target/path  (source/path)" or "target/path  (source/path)"
    const entryMatch = /^(\s*)(?:\*\+?|\+)?\s*([^\s#]+)\s+\(([^)]+)\)\s*(?:#.*)?$/.exec(raw);
    if (entryMatch) {
      tokens.push({
        type: 'entry',
        raw,
        lineIndex: i,
        parsed: { target: entryMatch[2] ?? '', source: entryMatch[3] ?? '' },
      });
      continue;
    }

    // Non-indented lines without (source) are headers (e.g., "browser.jar:" or Python assignment)
    if (/^\S.*[:+=]/.test(raw)) {
      tokens.push({ type: 'header', raw, lineIndex: i });
      continue;
    }

    // Fallback: treat indented lines without (source) as entries
    tokens.push({ type: 'entry', raw, lineIndex: i });
  }

  return tokens;
}

/**
 * A moz.build variable on the left of `+=`: `NAME`, `NAME.attribute` (the
 * `EXTRA_JS_MODULES.<namespace>` form the module scaffold writes and Firefox
 * uses) or `NAME[subscript]`.
 */
const LIST_TARGET = String.raw`[A-Z_][A-Z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?(?:\[[^\]]+\])?`;
const LIST_OPEN = new RegExp(String.raw`^${LIST_TARGET}\s*\+=\s*\[`);
const LIST_OPEN_BARE = new RegExp(String.raw`^${LIST_TARGET}\s*\+=\s*\[\s*$`);
const LIST_ONE_LINE = new RegExp(String.raw`^(${LIST_TARGET}\s*\+=\s*\[)(.*)\]\s*(#.*)?$`);

/**
 * Tokenizes a moz.build Python list block, returning the tokens and their
 * line range within the file.
 *
 * Supports both multi-line lists (the common shape) and single-line empty
 * lists of the form `EXTRA_JS_MODULES += []`, which a freshly-scaffolded
 * module directory's `moz.build` can start with.
 */
export function tokenizeMozBuildList(
  lines: string[],
  listPattern: RegExp,
  startAt = 0
): { tokens: MozBuildToken[]; startLine: number; endLine: number } | null {
  const tokens: MozBuildToken[] = [];
  let startLine = -1;
  let endLine = -1;

  for (let i = startAt; i < lines.length; i++) {
    const raw = lines[i] ?? '';

    if (startLine === -1) {
      if (LIST_OPEN.test(raw) && listPattern.test(raw)) {
        // Single-line empty-list handling: a fresh scaffold sometimes
        // writes `EXTRA_JS_MODULES += []` on one line, which a tokenizer
        // looking for a line starting with `]` never closes, leaving
        // `register` with a "Could not find module list section" error
        // against the documented browser/modules/<fork>/ scaffold.
        //
        // The in-place split rewrites the single-line form into the
        // canonical multi-line shape so the caller's
        // `lines.splice(insertIndex, 0, entry)` lands inside the list body.
        // The tokens are emitted to mirror the new structure.
        const singleLine = LIST_ONE_LINE.exec(raw);
        if (singleLine) {
          const openPart = singleLine[1] ?? '';
          const body = singleLine[2] ?? '';
          const values = [...body.matchAll(/(?:"([^"\\]*)"|'([^'\\]*)')\s*,?/g)];
          if (body.replace(/(?:"([^"\\]*)"|'([^'\\]*)')\s*,?/g, '').trim() !== '') return null;
          const itemLines = values.map((match) => `    "${match[1] ?? match[2] ?? ''}",`);
          const close = `]${singleLine[3] ? ` ${singleLine[3]}` : ''}`;
          lines.splice(i, 1, openPart, ...itemLines, close);
          startLine = i;
          endLine = i + itemLines.length + 1;
          tokens.push({ type: 'list-open', raw: openPart, lineIndex: i });
          for (const [index, item] of itemLines.entries()) {
            const value = values[index];
            tokens.push({
              type: 'list-item',
              raw: item,
              lineIndex: i + index + 1,
              parsed: { value: value?.[1] ?? value?.[2] ?? '' },
            });
          }
          tokens.push({ type: 'list-close', raw: close, lineIndex: endLine });
          break;
        }
        if (raw.includes(']') && !LIST_OPEN_BARE.test(raw)) return null;
        startLine = i;
        tokens.push({ type: 'list-open', raw, lineIndex: i });
      }
      continue;
    }

    // Inside the list block
    if (/^\s*\]/.test(raw)) {
      endLine = i;
      tokens.push({ type: 'list-close', raw, lineIndex: i });
      break;
    }

    const itemMatch = /^\s+["']([^"']+)["']\s*,?\s*(?:#.*)?$/.exec(raw);
    if (itemMatch) {
      tokens.push({
        type: 'list-item',
        raw,
        lineIndex: i,
        parsed: { value: itemMatch[1] ?? '' },
      });
    } else {
      tokens.push({ type: 'other', raw, lineIndex: i });
    }
  }

  if (startLine === -1 || endLine === -1) return null;
  return { tokens, startLine, endLine };
}
