// SPDX-License-Identifier: EUPL-1.2
/**
 * `observer-topic-naming` rule body, extracted from `patch-lint.ts`.
 *
 * Capturing the first string literal after the call's opening paren on a
 * single line mis-attributes string literals in complex subject arguments
 * and silently skips multi-line call sites. This scans the balanced argument
 * list (across newlines, string-aware), takes the *topic* argument by
 * position, and allowlists well-known Firefox-owned topics so tests that
 * simulate upstream notifications are not pushed toward renaming real
 * topics.
 */

import type { PatchLintIssue } from '../types/commands/index.js';

/**
 * Firefox-owned observer topics a fork legitimately observes or simulates.
 * These must never be flagged for fork-prefix naming, even when a fork's
 * binaryName happens to be a substring of one. `quit-application*` is
 * handled as a prefix family in {@link isKnownFirefoxTopic}.
 *
 * The list is deliberately conservative: it only needs to cover topics
 * whose text could plausibly contain a fork's binaryName, plus the
 * high-traffic lifecycle topics seen in downstream test simulations.
 */
export const KNOWN_FIREFOX_OBSERVER_TOPICS: ReadonlySet<string> = new Set([
  'idle-daily',
  'profile-after-change',
  'profile-before-change',
  'xpcom-shutdown',
  'xpcom-will-shutdown',
  'final-ui-startup',
  'browser-delayed-startup-finished',
  'sessionstore-windows-restored',
  'document-element-inserted',
  'content-document-global-created',
  'http-on-modify-request',
  'http-on-examine-response',
  'nsPref:changed',
  'browser-window-before-show',
  'domwindowopened',
  'domwindowclosed',
]);

/** True for allowlisted Firefox topics, including the quit-application family. */
export function isKnownFirefoxTopic(topic: string): boolean {
  return KNOWN_FIREFOX_OBSERVER_TOPICS.has(topic) || topic.startsWith('quit-application');
}

/**
 * Scans a balanced `( … )` argument span starting at `openParen` (which
 * must point at the opening paren) and splits it into top-level argument
 * strings. Tracks paren/brace/bracket depth and skips quoted runs, so
 * commas inside nested calls, object literals, or strings do not split.
 *
 * @returns The argument texts, or null when the span never closes within
 *   `maxLength` characters (malformed or truncated source — caller skips).
 */
function extractCallArguments(
  content: string,
  openParen: number,
  maxLength = 2000
): string[] | null {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  const end = Math.min(content.length, openParen + maxLength);

  for (let i = openParen; i < end; i++) {
    const ch = content[i] ?? '';
    if (quote !== null) {
      current += ch;
      if (ch === '\\') {
        current += content[i + 1] ?? '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      if (depth === 1 && ch === '(') continue; // the call's own paren
      current += ch;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && ch === ')') {
        args.push(current.trim());
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return null;
}

/**
 * Returns the literal string value when `arg` is exactly one plain string
 * literal (no concatenation, no `${}` interpolation), otherwise null.
 * Constant-named topics (identifiers, member expressions) intentionally
 * return null — hoisting a literal into a named constant is a supported
 * way to mark a topic as deliberate.
 */
function asStringLiteral(arg: string): string | null {
  const trimmed = arg.trim();
  if (trimmed.length < 2) return null;
  const quoteChar = trimmed[0];
  if (quoteChar !== "'" && quoteChar !== '"' && quoteChar !== '`') return null;
  if (trimmed[trimmed.length - 1] !== quoteChar) return null;
  const inner = trimmed.slice(1, -1);
  if (inner.includes(quoteChar)) return null; // concatenation like "a" + "b"
  if (quoteChar === '`' && inner.includes('${')) return null;
  return inner;
}

/**
 * Lints observer-service call sites in `strippedContent` (comments already
 * removed) for fork topic naming. Only topics that embed `binaryName` and
 * do not follow the `<binary>-<noun>-<verb>` convention are flagged;
 * allowlisted Firefox topics and constant-named topics are skipped.
 *
 * @param strippedContent - Source with comments stripped
 * @param file - File path for issue attribution
 * @param binaryName - Lowercased fork binary name
 * @returns Observer-topic naming issues
 */
export function lintObserverTopics(
  strippedContent: string,
  file: string,
  binaryName: string
): PatchLintIssue[] {
  const issues: PatchLintIssue[] = [];
  const callPattern = /\b(?:addObserver|removeObserver|notifyObservers)\s*\(/g;
  let callMatch: RegExpExecArray | null;

  while ((callMatch = callPattern.exec(strippedContent)) !== null) {
    const openParen = callMatch.index + callMatch[0].length - 1;
    const args = extractCallArguments(strippedContent, openParen);
    if (!args) continue;

    // Topic is the second argument for all three observer-service methods:
    // addObserver(observer, topic[, weak]), removeObserver(observer, topic),
    // notifyObservers(subject, topic[, data]).
    const topicArg = args[1];
    if (topicArg === undefined) continue;
    const topic = asStringLiteral(topicArg);
    if (topic === null) continue;
    if (isKnownFirefoxTopic(topic)) continue;

    if (topic.toLowerCase().includes(binaryName) && !/^[\w]+-[a-z]+-[a-z]+/.test(topic)) {
      issues.push({
        file,
        check: 'observer-topic-naming',
        message: `Observer topic "${topic}" should follow "${binaryName}-<noun>-<verb>" naming convention.`,
        severity: 'warning',
      });
    }
  }

  return issues;
}
