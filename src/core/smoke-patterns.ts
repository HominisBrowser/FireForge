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
 * Additions here should be conservative — false positives turn every
 * smoke run into noise for operators and every CI run into flake.
 */
export const SMOKE_ERROR_PATTERNS: readonly RegExp[] = [
  // Firefox chrome error lines — `JavaScript error: chrome://…, line N: TypeError: …`.
  /^\s*JavaScript error:/i,
  // Some log paths prefix browser-console `console.error(...)` with the literal label below.
  /^\s*console\.error:/i,
  // Older bracketed-prefix variant still seen in some chrome logs / test runs.
  /^\s*\[JavaScript (Error|Warning)\]/i,
  // IPC-layer fatal assertions — Firefox prints `###!!! [Parent] Error: …` on content-process crashes.
  /^\s*###!!! \[Parent\]/,
];

/**
 * Returns `true` when `line` matches any pattern in
 * {@link SMOKE_ERROR_PATTERNS}. Does not consult the allowlist — that step
 * lives in {@link matchesAllowlist}, so the smoke runner can count
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
 * Returns `true` when `line` matches any regex in `allow`. Safe to call
 * with an empty allowlist (always returns `false`).
 */
export function matchesAllowlist(line: string, allow: readonly RegExp[]): boolean {
  for (const pattern of allow) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses a newline-delimited allowlist file body. Lines are trimmed; blank
 * lines and `#`-prefixed comments are skipped. Each remaining line is
 * compiled as a RegExp. A bad pattern throws immediately — better to fail
 * fast at CLI parse time than to silently let a typo match nothing.
 */
export function compileAllowlistFromFile(body: string, sourcePath: string): RegExp[] {
  const lines = body.split(/\r?\n/);
  const compiled: RegExp[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      compiled.push(new RegExp(line));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid allowlist regex at ${sourcePath}:${String(index + 1)}: ${message}`, {
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
export function compileAllowlistFromStrings(sources: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  sources.forEach((source, index) => {
    try {
      compiled.push(new RegExp(source));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid --console-allow regex at position ${String(index + 1)} ("${source}"): ${message}`,
        { cause: error }
      );
    }
  });
  return compiled;
}
