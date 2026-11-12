// SPDX-License-Identifier: EUPL-1.2
import type { Transaction } from '../kernel/journal.js';
import type { TrackedFiles } from '../project/index.js';

/** Tracked files held in memory. */
export interface MemoryFiles extends TrackedFiles {
  /** The files by path; tests read and set them directly. */
  readonly contents: Map<string, string>;
}

/** The transaction to hand code that writes to {@link memoryFiles}, which never consults it. */
export const noTransaction = {} as Transaction;

/**
 * A file set in memory, for tests of code that reads and writes files through
 * `TrackedFiles`. Writes land at once; the transaction is not consulted.
 *
 * @param initial - Content by path
 */
export function memoryFiles(initial: Readonly<Record<string, string>> = {}): MemoryFiles {
  const contents = new Map(Object.entries(initial));
  return {
    contents,
    read: (path) => Promise.resolve(contents.get(path)),
    exists: (path) => Promise.resolve(contents.has(path)),
    write: (_tx, path, content) => {
      contents.set(path, content);
      return Promise.resolve();
    },
    remove: (_tx, path) => {
      contents.delete(path);
      return Promise.resolve();
    },
    locate: (path) => path,
  };
}
