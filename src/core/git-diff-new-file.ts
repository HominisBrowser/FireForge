// SPDX-License-Identifier: EUPL-1.2
/**
 * Decides how a NEW (untracked) file travels inside a patch: as a synthesized
 * `+`-line text body, or as a `GIT binary patch`.
 *
 * The text body is built from a JavaScript string, and the `index` line next
 * to it comes from `git hash-object` over the file's real bytes. Those two
 * agree only when the bytes decode losslessly as UTF-8. A Latin-1
 * `.properties` or `.rc` file has no NUL byte — git's own binary heuristic
 * calls it text — but a UTF-8 decode turns every high byte into U+FFFD, so
 * the patch body and its blob hash disagree, `git apply` writes different
 * bytes than the tree holds, and every drift check flags the file forever.
 * A binary patch carries the bytes verbatim, so it is the faithful choice for
 * anything that is not valid UTF-8. This module is the single place that
 * decision is made.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isBinaryFile } from './git-file-ops.js';

/** How a new file is carried in a patch, plus its text when it is text. */
export type NewFileContent =
  { readonly binary: true } | { readonly binary: false; readonly content: string };

// `ignoreBOM: true` keeps a leading U+FEFF in the output instead of silently
// consuming it, matching `readFile(path, 'utf-8')`, so a BOM-prefixed file
// still renders the byte the blob hash was computed over.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Decodes bytes as UTF-8, or reports that they are not valid UTF-8.
 * @param bytes - Raw file bytes
 * @returns The decoded text, or undefined when any sequence is malformed
 */
function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch (error: unknown) {
    void error;
    return undefined;
  }
}

/**
 * Reads a new (untracked) file and classifies it for patch generation.
 *
 * A file is binary when git's NUL-byte heuristic says so
 * ({@link isBinaryFile}) OR when its bytes are not valid UTF-8 — see the
 * module comment for why the second arm exists. Text files come back with
 * their exact decoded content so callers do not read the file twice.
 *
 * @param repoDir - Repository directory
 * @param filePath - File path (relative to repo root)
 * @returns The classification, with content for text files
 */
export async function readNewFileContent(
  repoDir: string,
  filePath: string
): Promise<NewFileContent> {
  if (await isBinaryFile(repoDir, filePath)) {
    return { binary: true };
  }
  const content = decodeStrictUtf8(await readFile(join(repoDir, filePath)));
  if (content === undefined) {
    return { binary: true };
  }
  return { binary: false, content };
}

/**
 * Renders one repo-relative path as an anchored, literal gitattributes
 * pattern: the whole thing is C-quoted (which gitattributes accepts for
 * patterns holding spaces or `#`) and glob metacharacters carry a backslash
 * that survives the unquoting, so git matches them literally.
 *
 * Both escapes are applied in a single pass, keyed on the source character.
 * Escaping in two passes would re-escape the backslashes the first pass just
 * added, and a backslash that is part of the filename would have to be
 * escaped for the glob layer as well as the quoting layer — which a
 * glob-only first pass cannot tell apart from one it emitted itself.
 *
 * @param filePath - File path (relative to repo root)
 * @returns A pattern matching exactly that path
 */
function toLiteralAttributePattern(filePath: string): string {
  // `"` only needs the quoting layer, so one backslash. A glob
  // metacharacter takes a backslash for the glob layer, which the quoting
  // layer then doubles into two. A literal `\` is both: the glob layer
  // doubles it, then the quoting layer doubles that again, for four.
  const escaped = filePath.replace(/["\\*?[\]]/g, (char) => {
    if (char === '"') return '\\"';
    if (char === '\\') return '\\\\\\\\';
    return `\\\\${char}`;
  });
  return `"/${escaped}"`;
}

/**
 * Runs `task` with git config arguments that force `filePath` to be diffed
 * as binary.
 *
 * `git diff --binary` only emits a `GIT binary patch` for a file git itself
 * classifies as binary, and git's classifier is the NUL heuristic — a
 * Latin-1 file passes it and comes out as a TEXT diff whose high bytes are
 * then mangled by the UTF-8 decode every subprocess result goes through.
 * The `-diff` attribute is how git is told otherwise, and a throwaway
 * `core.attributesFile` naming just this path is the narrowest way to set it
 * without touching the tree's own `.gitattributes`. (An in-tree attribute
 * that explicitly sets `diff` for the path would still win; the tree's own
 * attributes are its business.)
 *
 * @param filePath - File path (relative to repo root)
 * @param task - Receives `['-c', 'core.attributesFile=...']` to splice ahead
 *   of the git subcommand
 * @returns Whatever `task` returns
 */
export async function withForcedBinaryAttribute<T>(
  filePath: string,
  task: (gitConfigArgs: string[]) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fireforge-attr-'));
  try {
    const attributesFile = join(tempDir, 'attributes');
    await writeFile(attributesFile, `${toLiteralAttributePattern(filePath)} -diff\n`);
    return await task(['-c', `core.attributesFile=${attributesFile}`]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
