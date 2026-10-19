// SPDX-License-Identifier: EUPL-1.2
/**
 * Prefixes every line of a chunked stream, for output from several
 * concurrent harness instances (`fireforge test --jobs`) that share one
 * terminal and one run log. Without a prefix, interleaved lines from two
 * browsers cannot be attributed after the fact.
 */

/** A stateful line prefixer for one stream. */
export interface LinePrefixer {
  /** Returns `chunk` with the prefix inserted at the start of each line. */
  transform(chunk: string): string;
}

/**
 * Creates a prefixer. Line state carries across chunks, so a line split
 * between two chunks gets the prefix exactly once.
 *
 * @param prefix - Text to insert, e.g. `[job 2] `
 */
export function createLinePrefixer(prefix: string): LinePrefixer {
  let atLineStart = true;
  return {
    transform(chunk) {
      if (chunk.length === 0) return chunk;
      let out = '';
      let start = 0;
      for (let index = chunk.indexOf('\n'); index !== -1; index = chunk.indexOf('\n', start)) {
        out += `${atLineStart ? prefix : ''}${chunk.slice(start, index + 1)}`;
        atLineStart = true;
        start = index + 1;
      }
      if (start < chunk.length) {
        out += `${atLineStart ? prefix : ''}${chunk.slice(start)}`;
        atLineStart = false;
      }
      return out;
    },
  };
}
