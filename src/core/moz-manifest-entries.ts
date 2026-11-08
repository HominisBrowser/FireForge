// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../errors/base.js';
import { type JarMnToken, tokenizeJarMn, tokenizeMozBuildList } from './moz-manifest-tokenizers.js';

/** A parsed packaging entry together with its archive and conditional scope. */
interface ScopedJarToken {
  token: JarMnToken;
  archive: number;
  conditional: boolean;
}

/** Preserve preprocessor nesting and archive identity without evaluating build flags. */
export function scopedJarTokens(content: string): ScopedJarToken[] {
  let depth = 0;
  let archive = 0;
  const result = tokenizeJarMn(content.split('\n')).map((token) => {
    const text = token.raw.trim();
    if (/^#\s*endif\b/.test(text)) {
      if (depth === 0) throw new GeneralError('Unbalanced jar.mn conditional');
      depth--;
    }
    if (/^#\s*(?:else|elif)\b/.test(text) && depth === 0)
      throw new GeneralError('Unbalanced jar.mn conditional');
    if (token.type === 'header') archive++;
    const scoped = { token, archive, conditional: depth !== 0 };
    if (/^#\s*(?:if|ifdef|ifndef)\b/.test(text)) depth++;
    return scoped;
  });
  if (depth !== 0) throw new GeneralError('Unbalanced jar.mn conditional');
  return result;
}

/** Match actual jar destinations and sources rather than comments or path prefixes. */
export function jarHasEntry(content: string, targets: readonly string[], source: string): boolean {
  return tokenizeJarMn(content.split('\n')).some(
    (token) =>
      token.type === 'entry' &&
      token.parsed !== undefined &&
      targets.includes(token.parsed.target) &&
      token.parsed.source === source
  );
}

/** Read values only from an exact, unconditional Python packaging list. */
export function mozBuildListContains(content: string, listName: string, value: string): boolean {
  const pattern = new RegExp(`^${listName}\\b`);
  const lines = content.split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    const result = tokenizeMozBuildList(lines, pattern, cursor);
    if (!result) return false;
    if (result.tokens.some((token) => token.type === 'list-item' && token.parsed?.value === value))
      return true;
    cursor = result.endLine + 1;
  }
  return false;
}
