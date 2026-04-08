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
    const entryMatch = /^(\s*)(\S+)\s+\(([^)]+)\)/.exec(raw);
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
 * Tokenizes a moz.build Python list block, returning the tokens and their
 * line range within the file.
 */
export function tokenizeMozBuildList(
  lines: string[],
  listPattern: RegExp
): { tokens: MozBuildToken[]; startLine: number; endLine: number } | null {
  const tokens: MozBuildToken[] = [];
  let startLine = -1;
  let endLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';

    if (startLine === -1) {
      if (listPattern.test(raw)) {
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

    const itemMatch = /^\s+["']([^"']+)["']/.exec(raw);
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
