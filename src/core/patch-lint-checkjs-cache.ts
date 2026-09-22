// SPDX-License-Identifier: EUPL-1.2
/**
 * Parsed-source sharing across checkJs programs.
 *
 * Its own module rather than part of `patch-lint-checkjs.ts` only because
 * that file sits on a 500-line budget.
 */
import { sha256Hex } from '../utils/hash.js';

/**
 * Parsed `SourceFile`s reused across programs, keyed by file name and the
 * parse options TypeScript asked for. The language service shares files
 * across programs the same way (its document registry): a `SourceFile` is
 * parsed and bound once, and every program that includes it reuses both.
 * Only valid while the files cannot change and every program uses the same
 * compiler options, which holds within one lint run.
 */
export type CheckJsSourceFileCache = Map<string, import('typescript').SourceFile>;

/**
 * Wraps a host's `getSourceFile` so each file is parsed at most once per
 * cache. The shim is keyed by its content as well, since the shim text is
 * composed per call rather than read from disk.
 */
function cachingGetSourceFile(
  cache: CheckJsSourceFileCache,
  shimPath: string,
  shimSource: string,
  getSourceFile: import('typescript').CompilerHost['getSourceFile']
): import('typescript').CompilerHost['getSourceFile'] {
  const shimDigest = sha256Hex(shimSource);
  return (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const parse =
      typeof languageVersionOrOptions === 'object'
        ? `${languageVersionOrOptions.languageVersion}|${String(languageVersionOrOptions.impliedNodeFormat)}`
        : String(languageVersionOrOptions);
    const key =
      fileName === shimPath ? `${fileName}\0${parse}\0${shimDigest}` : `${fileName}\0${parse}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const created = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    if (created !== undefined) cache.set(key, created);
    return created;
  };
}

/**
 * Returns `host` with a shared-parse `getSourceFile` when a cache is given,
 * or `host` itself when not.
 * @param host - The program's compiler host
 * @param cache - Shared parse cache, or undefined for an unshared program
 * @param shimPath - Path the host serves the composed shim at
 * @param shimSource - The composed shim text
 */
export function withSharedSourceFiles(
  host: import('typescript').CompilerHost,
  cache: CheckJsSourceFileCache | undefined,
  shimPath: string,
  shimSource: string
): import('typescript').CompilerHost {
  if (cache === undefined) return host;
  return {
    ...host,
    getSourceFile: cachingGetSourceFile(cache, shimPath, shimSource, host.getSourceFile.bind(host)),
  };
}
