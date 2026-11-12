// SPDX-License-Identifier: EUPL-1.2

/**
 * Escapes every regular-expression metacharacter in `text`.
 *
 * @param text - Literal text to match
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits text into lines on `\n` or `\r\n`, without a trailing empty line.
 *
 * @param text - The text
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The last `count` non-empty lines of `text`.
 *
 * @param text - The text
 * @param count - How many lines to keep
 */
export function tailLines(text: string, count: number): string[] {
  return splitLines(text)
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
};

/**
 * Decodes a C-style quoted string, the form git writes a path in when it
 * holds a quote, a backslash, a control character or (under
 * `core.quotePath`) any byte outside printable ASCII: `"dir/f\303\274r.js"`.
 * Octal escapes are raw bytes, so the result is bytes; a git path decodes
 * from them as UTF-8.
 *
 * @param quoted - The text, with or without its surrounding double quotes
 * @param encoding - How the unescaped characters map to bytes
 */
export function unquoteC(quoted: string, encoding: 'utf8' | 'latin1' = 'utf8'): Buffer {
  const body =
    quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')
      ? quoted.slice(1, -1)
      : quoted;
  const parts: Buffer[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) parts.push(Buffer.from(literal, encoding));
    literal = '';
  };
  for (let index = 0; index < body.length; index++) {
    const char = body.charAt(index);
    const next = body.charAt(index + 1);
    if (char !== '\\' || next === '') {
      literal += char;
      continue;
    }
    flush();
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(index + 1, index + 4))?.[0];
    if (octal !== undefined) {
      parts.push(Buffer.from([parseInt(octal, 8)]));
      index += 3;
    } else {
      parts.push(Buffer.from([C_ESCAPES[next] ?? next.charCodeAt(0)]));
      index += 1;
    }
  }
  flush();
  return Buffer.concat(parts);
}

/** A partial line longer than this is dispatched as it stands, so the buffer stays bounded. */
const MAX_PARTIAL_LINE = 1024 * 1024;

/**
 * Turns a chunked stream into lines. `\n`, `\r\n` and a lone `\r` (progress
 * bars that repaint a line) all end a line. A trailing `\r` is held back,
 * since it may be the first half of a `\r\n` split across chunks.
 *
 * @param onLine - Receives each complete line
 * @returns `push` for each chunk and `flush` for the final partial line
 */
export function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index === -1) break;
        if (buffer[index] === '\r' && index === buffer.length - 1) break;
        const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + width);
        onLine(line);
      }
      if (buffer.length > MAX_PARTIAL_LINE) {
        onLine(buffer);
        buffer = '';
      }
    },
    flush() {
      const rest = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      buffer = '';
      if (rest.length > 0) onLine(rest);
    },
  };
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The candidate most likely meant by a mistyped `input`, or undefined when
 * none is close enough to suggest.
 *
 * @param input - What was typed
 * @param candidates - The valid names
 */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  const limit = Math.max(2, Math.floor(input.length / 3));
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(input.toLowerCase(), name.toLowerCase());
    if (distance <= limit && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best?.name;
}
