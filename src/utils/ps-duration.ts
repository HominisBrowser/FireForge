// SPDX-License-Identifier: EUPL-1.2
/**
 * Parser for the duration fields `ps` prints.
 *
 * Two different columns share one grammar, which is why this lives apart
 * from either consumer: `time=` (accumulated CPU) and `etime=` (elapsed
 * wall clock). Reading them with one parser is deliberate — a second
 * hand-rolled copy is how the two would drift, and the darwin dialect is
 * the half that is easy to get wrong.
 *
 * Dialects:
 *   - linux `[dd-]hh:mm:ss` (e.g. `26-03:14:12`, `03:14:12`)
 *   - darwin/BSD `mm:ss.cc`, whose minutes field accumulates without
 *     wrapping (e.g. `38412:07.55`)
 *
 * Returns `NaN` for anything else, so callers must treat an unrecognized
 * shape as "unknown" rather than as zero — a browser reported as 0 seconds
 * old would be exactly the wrong attribution.
 */

/**
 * Parses a `ps` duration field into whole seconds.
 *
 * @param value - Raw field text, e.g. `03:14:12` or `38412:07.55`
 * @returns Seconds, or `NaN` when the shape is not recognized
 */
export function parsePsDuration(value: string): number {
  const trimmed = value.trim();
  let days = 0;
  let rest = trimmed;
  const dayMatch = /^(\d+)-(.*)$/.exec(trimmed);
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = dayMatch[2] ?? '';
  }
  const parts = rest.split(':');
  if (parts.length === 3) {
    // hh:mm:ss (linux; seconds may not carry fractions but tolerate them)
    const [h, m, s] = parts.map(Number);
    if ([h, m, s].some((n) => Number.isNaN(n))) return NaN;
    return days * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
  }
  if (parts.length === 2) {
    // mm:ss.cc (darwin — the minutes field accumulates without wrapping)
    const [m, s] = parts.map(Number);
    if ([m, s].some((n) => Number.isNaN(n))) return NaN;
    return days * 86400 + (m ?? 0) * 60 + (s ?? 0);
  }
  return NaN;
}

/**
 * Renders a duration for an operator-facing line: `4s`, `3m12s`, `2h05m`.
 * Returns `undefined` for `NaN`, so a caller can omit the clause entirely
 * rather than print "unknown" noise.
 */
export function formatPsDuration(seconds: number): string | undefined {
  if (Number.isNaN(seconds) || seconds < 0) return undefined;
  if (seconds < 60) return `${String(Math.floor(seconds))}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m)}m${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h)}h${String(m).padStart(2, '0')}m`;
}
