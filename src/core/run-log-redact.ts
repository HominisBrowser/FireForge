// SPDX-License-Identifier: EUPL-1.2
/**
 * Conservative secret redaction for the run-log FILE tee.
 *
 * A run log is a complete copy of mach's output, and mach echoes its
 * environment in places (configure summaries, `mach env`, harness
 * diagnostics that print the command line). The terminal already showed
 * every byte to the operator who ran it. The file, by contrast, is retained
 * twenty deep and gets attached to bug reports. So the file gets a narrow
 * masking pass and the terminal does not.
 *
 * Minimal and pattern-based. See {@link redactRunLogText} for the exact
 * contract. It is a seatbelt against the common accidental leak, not a
 * guarantee that a log is free of secrets.
 */

/** Env-style keys whose assigned value is masked. */
const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH)/i;

/**
 * `KEY=value` where KEY is an identifier and the value runs to the next
 * whitespace, or is a single/double-quoted string. The leading group keeps
 * the assignment anchored at a token boundary so `x.y=z` is not split
 * mid-token. A hyphen IS a boundary: mach and configure echo their argv, so
 * `--token=…`, `--password=…` and `-DAUTH_TOKEN=…` are exactly the forms a
 * retained log would otherwise carry verbatim (the lead keeps the dash, and
 * the key is what follows it). Empty values are left alone (nothing to hide).
 */
const ENV_ASSIGNMENT_PATTERN =
  /(^|[\s"'([{,;-])([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"',;)\]}]+)/g;

/** `Authorization: <scheme> <credential>` (scheme optional) in HTTP dumps. */
const AUTHORIZATION_HEADER_PATTERN = /(authorization\s*:\s*)(?:(bearer|basic|token)\s+)?(\S+)/gi;

/** Marker written in place of a masked value. */
const REDACTED = '<redacted>';

function redactLine(line: string): string {
  return line
    .replace(ENV_ASSIGNMENT_PATTERN, (whole, lead: string, key: string) =>
      SECRET_KEY_PATTERN.test(key) ? `${lead}${key}=${REDACTED}` : whole
    )
    .replace(AUTHORIZATION_HEADER_PATTERN, (_whole, lead: string, scheme: string | undefined) =>
      scheme === undefined ? `${lead}${REDACTED}` : `${lead}${scheme} ${REDACTED}`
    );
}

/**
 * Masks the obvious secret shapes in run-log text, line by line.
 *
 * Redacted:
 * - the value of an env-style assignment `KEY=value` whose KEY matches
 *   `/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH)/i`. The value up to the
 *   next whitespace, or a whole quoted string, becomes `KEY=<redacted>`.
 *   The `--flag=value` and `-DNAME=value` spellings of the same shape are
 *   covered (`--password=x` → `--password=<redacted>`).
 * - the credential of an `Authorization:` header (`Bearer`, `Basic` and
 *   `Token` schemes keep the scheme word, and anything else masks the
 *   whole value).
 *
 * Not redacted: secrets that appear without one of those key names or
 * headers (a bare token in a URL query string, a space-separated
 * `--password foo` CLI argument, JSON `"token": "..."` fields, cookies).
 * Line structure and every other byte pass through unchanged. `\n`, `\r\n`
 * and lone `\r` all delimit lines, so carriage-return-repainted progress
 * output is masked per repaint.
 *
 * @param text - One or more complete lines
 * @returns The same text with masked values
 */
export function redactRunLogText(text: string): string {
  if (text.length === 0) return text;
  // Split with a capturing group so the terminators survive the round trip.
  // Odd indices are the terminators themselves.
  return text
    .split(/(\r\n|\n|\r)/)
    .map((part, index) => (index % 2 === 0 ? redactLine(part) : part))
    .join('');
}
