// SPDX-License-Identifier: EUPL-1.2
/**
 * Line splitting for the smoke-run stream dispatch in `process.ts`. Kept as
 * a sibling so the exec module stays within its size budget; the contract
 * (terminators, partial-line cap) is documented on the function.
 */

/**
 * Cap on the partial-line tail kept between chunks. A child emitting one
 * enormous line with no terminator (minified JS dumped to stderr, a raw
 * binary blob) would otherwise grow the buffer without bound — the 50 MB cap
 * guards the collector, not these line buffers. When the tail exceeds the
 * cap it is dispatched as a synthetic (oversized) line so the matchers still
 * see its content, then the buffer resets.
 */
const MAX_PARTIAL_LINE_SIZE = 1024 * 1024;

/**
 * Drains complete lines from `buffer`, dispatching each to `cb`. Treats
 * `\n`, `\r\n`, and lone `\r` as line terminators — the lone-`\r` case
 * matters for progress-bar style output (mach, cargo) that repaints a line
 * with carriage returns and never sends a newline, which otherwise
 * accumulates indefinitely. A single trailing `\r` is held back since it may
 * be the first half of a `\r\n` pair split across chunks. Returns the
 * remaining partial line — callers keep accumulating into it.
 */
export function dispatchCompleteLines(
  buffer: string,
  cb: ((line: string) => void) | undefined
): string {
  let searchFrom = 0;
  for (;;) {
    const nl = buffer.indexOf('\n', searchFrom);
    const cr = buffer.indexOf('\r', searchFrom);
    const idx = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    if (idx === -1) break;
    if (buffer[idx] === '\r' && idx === buffer.length - 1) {
      // Possible first half of a chunk-split \r\n — wait for the next chunk.
      break;
    }
    const line = buffer.slice(0, idx);
    const terminatorLength = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
    buffer = buffer.slice(idx + terminatorLength);
    searchFrom = 0;
    cb?.(line);
  }
  if (buffer.length > MAX_PARTIAL_LINE_SIZE) {
    cb?.(buffer);
    return '';
  }
  return buffer;
}
