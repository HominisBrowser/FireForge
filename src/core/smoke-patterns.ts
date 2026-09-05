// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared regex library for `fireforge run --smoke-exit`. Used by the smoke
 * runner to decide whether a console line from the real chrome counts as a
 * runtime error. Kept separate from the runner so the patterns can be
 * exercised in isolation and amended without touching process-group logic.
 *
 * Matching is anchored at the start of the line (`^`) on purpose: a runtime
 * error leaves a canonical prefix that Firefox's logging layer prints at
 * column zero. Embedded mentions of the same string inside an unrelated
 * warning (e.g. `"pending JavaScript error cleanup"`) do not start with
 * the prefix and should not trip the scanner.
 */

/**
 * Line prefixes that signal an actual runtime error in a Firefox chrome
 * process. A hit on any of these patterns is a smoke failure unless the
 * line also matches the caller-supplied allowlist.
 *
 * Additions here should be conservative. False positives turn every
 * smoke run into noise for operators and every CI run into flake.
 */
import { toError } from '../utils/errors.js';

const SMOKE_ERROR_PATTERNS: readonly RegExp[] = [
  // Firefox chrome error lines: `JavaScript error: chrome://…, line N: TypeError: …`.
  /^\s*JavaScript error:/i,
  // Some log paths prefix browser-console `console.error(...)` with the literal label below.
  /^\s*console\.error:/i,
  // Older bracketed-prefix variant still seen in some chrome logs / test runs.
  /^\s*\[JavaScript (Error|Warning)\]/i,
  // IPC-layer fatal assertions. Firefox prints `###!!! [Parent] Error: …` on content-process crashes.
  /^\s*###!!! \[Parent\]/,
  // A chrome:// or resource:// URL that resolves to nothing. Outside
  // automation Gecko only PRINTS this (printf_stderr in
  // `CheckForBrokenChromeURL`, netwerk/base/nsNetUtil.cpp). Under
  // `xpc::IsInAutomation()` the same condition is a
  // `MOZ_CRASH_UNSAFE_PRINTF` in whichever process opened the channel. So
  // the smoke probe, which runs outside automation, sees the printed
  // line for the same defect that hard-crashes every harness run, and a
  // probe that exits 0 on it reports "startup is healthy" for a build that
  // hangs at "Waiting for browser…". Both spellings are matched: the
  // non-automation singular `URL:` and the automation plural `URLs:`.
  // Allowlistable through `--console-allow` like any other pattern.
  /^\s*Missing chrome or resource URLs?:/,
];

/**
 * Returns `true` when `line` matches any pattern in
 * {@link SMOKE_ERROR_PATTERNS}. Does not consult the allowlist. That step
 * lives in {@link matchAllowlist}, so the smoke runner can count
 * allowlisted hits separately from raw error matches for its summary.
 */
export function matchesSmokeError(line: string): boolean {
  for (const pattern of SMOKE_ERROR_PATTERNS) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * One compiled allowlist entry with its provenance retained so the smoke
 * summary can attribute hits per entry. An entry that silently
 * stops matching (its suppressed shape changed upstream) is only
 * detectable when zero-hit entries are visible.
 */
export interface CompiledAllowlistEntry {
  pattern: RegExp;
  /** Verbatim source text of the entry. */
  source: string;
  /** Human-readable origin: `allow.txt:12` or `--console-allow #2`. */
  origin: string;
}

/**
 * Returns the index of the FIRST entry in `allow` matching `line`, or -1.
 * First-match attribution is deterministic and cheap. A line matching
 * several entries credits the earliest one. Safe to call with an empty
 * allowlist (always returns -1).
 */
export function matchAllowlist(line: string, allow: readonly CompiledAllowlistEntry[]): number {
  return allow.findIndex((entry) => entry.pattern.test(line));
}

/**
 * Parses a newline-delimited allowlist file body. Lines are trimmed. Blank
 * lines and `#`-prefixed comments are skipped. Each remaining line is
 * compiled as a RegExp with its `<file>:<line>` origin retained. A bad
 * pattern throws immediately: better to fail fast at CLI parse time than
 * to silently let a typo match nothing.
 */
export function compileAllowlistFromFile(
  body: string,
  sourcePath: string
): CompiledAllowlistEntry[] {
  const lines = body.split(/\r?\n/);
  const compiled: CompiledAllowlistEntry[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      compiled.push({
        pattern: new RegExp(line),
        source: line,
        origin: `${sourcePath}:${index + 1}`,
      });
    } catch (error: unknown) {
      const message = toError(error).message;
      throw new Error(`Invalid allowlist regex at ${sourcePath}:${index + 1}: ${message}`, {
        cause: error,
      });
    }
  });
  return compiled;
}

/**
 * Compiles an array of regex-string inputs (e.g. repeated `--console-allow`
 * flag values). Same fail-fast semantics as {@link compileAllowlistFromFile}.
 */
export function compileAllowlistFromStrings(sources: readonly string[]): CompiledAllowlistEntry[] {
  const compiled: CompiledAllowlistEntry[] = [];
  sources.forEach((source, index) => {
    try {
      compiled.push({
        pattern: new RegExp(source),
        source,
        origin: `--console-allow #${index + 1}`,
      });
    } catch (error: unknown) {
      const message = toError(error).message;
      throw new Error(
        `Invalid --console-allow regex at position ${index + 1} ("${source}"): ${message}`,
        { cause: error }
      );
    }
  });
  return compiled;
}
