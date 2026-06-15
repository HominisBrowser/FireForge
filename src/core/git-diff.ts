// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { GitError } from '../errors/git.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { chunkPathspecs, ensureGit, git } from './git-base.js';
import {
  fileExistsInHead,
  hashObjectBatch,
  isBinaryFile,
  listTrackedInHead,
} from './git-file-ops.js';
import { getUntrackedFiles, getUntrackedFilesInDir } from './git-status.js';

async function execGitWithAllowedExitCodes(
  repoDir: string,
  args: string[],
  allowedExitCodes: number[] = [0]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await exec('git', args, { cwd: repoDir });
  if (allowedExitCodes.includes(result.exitCode)) {
    return result;
  }

  throw new GitError(result.stderr.trim() || 'Git command failed', args.join(' '));
}

/**
 * Gets the diff for a specific file.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns Diff content
 */
export async function getFileDiff(repoDir: string, filePath: string): Promise<string> {
  await ensureGit();
  return git(['diff', 'HEAD', '--', filePath], repoDir);
}

/**
 * Abbreviates a full git blob hash to the 10-character form used in the
 * synthesized `index 0000000000..<hash>` line, falling back to the all-zero
 * placeholder when no usable hash is available. Mirrors the original per-file
 * truncation exactly.
 * @param fullHash - Full blob hash, or undefined when hashing failed
 * @returns 10-character abbreviated hash or the zero placeholder
 */
function abbreviateBlobHash(fullHash: string | undefined): string {
  if (fullHash !== undefined && fullHash.length >= 10) {
    return fullHash.slice(0, 10);
  }
  return '0000000000';
}

/**
 * Pure formatter for a new (untracked) file's unified diff. Extracted from
 * {@link generateNewFileDiff} so the batched cold-run path in
 * {@link getDiffForFilesAgainstHead} and the standalone path share one source of
 * truth — the only thing that differs between them is where `blobHash` comes
 * from (a single batched `git hash-object` vs a per-file one), never the
 * formatting. Preserves the empty-file form, the trailing-newline handling, and
 * the "No newline at end of file" marker byte-for-byte.
 * @param filePath - Path to the file (relative to repo)
 * @param content - File content
 * @param blobHash - Abbreviated blob hash for the index line
 * @returns Diff content in unified diff format
 */
function buildNewFileDiffBody(filePath: string, content: string, blobHash: string): string {
  // Handle empty files
  if (content.length === 0) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      `index 0000000000..${blobHash}`,
      '--- /dev/null',
      `+++ b/${filePath}`,
      '',
    ].join('\n');
  }

  const lines = content.split('\n');

  // Handle files that don't end with newline
  const hasTrailingNewline = content.endsWith('\n');
  const lineCount = hasTrailingNewline ? lines.length - 1 : lines.length;

  // Build the unified diff format for a new file
  const diffLines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    `index 0000000000..${blobHash}`,
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
  ];

  // Add each line with a + prefix
  for (let i = 0; i < lineCount; i++) {
    diffLines.push(`+${lines[i]}`);
  }

  // Add "No newline at end of file" marker if needed
  if (!hasTrailingNewline && lineCount > 0) {
    diffLines.push('\\ No newline at end of file');
  }

  return diffLines.join('\n') + '\n';
}

/**
 * Generates a unified diff for a new (untracked) file.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns Diff content in unified diff format
 */
export async function generateNewFileDiff(repoDir: string, filePath: string): Promise<string> {
  const fullPath = join(repoDir, filePath);

  // Defensive check: a directory here means a caller bypassed the
  // expansion layers and handed the leaf reader a path it cannot
  // read. Surface it with an actionable message naming the offending
  // path rather than the raw `EISDIR` that `readText` would throw —
  // recurring bug class (see the belt-and-suspenders note in
  // `getDiffForFilesAgainstHead`).
  const fileStat = await stat(fullPath);
  if (fileStat.isDirectory()) {
    throw new GitError(
      `expected a file but found a directory at '${filePath}' — caller must expand directory entries before diffing`,
      `hash-object ${filePath}`
    );
  }

  const content = await readText(fullPath);

  // Compute the abbreviated git blob hash for the index line
  let blobHash = '0000000000';
  try {
    const fullHash = (await git(['hash-object', fullPath], repoDir)).trim();
    blobHash = abbreviateBlobHash(fullHash);
  } catch (error: unknown) {
    verbose(
      `git hash-object failed for ${filePath}; falling back to zero blob hash: ${toError(error).message}`
    );
  }

  return buildNewFileDiffBody(filePath, content, blobHash);
}

/**
 * Generates a patch for a file.
 * If the file is tracked in HEAD, it generates a standard contextual diff.
 * If the file is untracked (new), it generates a "new file" format patch (snapshot).
 * This ensures standard 3-way mergeable context diffs for existing Mozilla files.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns Diff content in unified diff format
 */
export async function generateFullFilePatch(repoDir: string, filePath: string): Promise<string> {
  await ensureGit();

  // If file exists in HEAD, use standard git diff HEAD -- <file>
  // This generates a contextual diff that is safer for rebasing
  if (await fileExistsInHead(repoDir, filePath)) {
    return getFileDiff(repoDir, filePath);
  }

  // If file is new/untracked, use the full-file "new file" format
  return generateNewFileDiff(repoDir, filePath);
}

/**
 * Generates a unified diff between base content and current file content.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @param baseContent - The base content to diff against
 * @returns Unified diff in git format
 */
export async function generateModificationDiff(
  repoDir: string,
  filePath: string,
  baseContent: string
): Promise<string> {
  const fullPath = join(repoDir, filePath);
  const currentContent = await readText(fullPath);

  // If contents are identical, return empty diff
  if (baseContent === currentContent) {
    return '';
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'fireforge-diff-'));
  const tempFile = join(tempDir, basename(filePath));

  try {
    await writeFile(tempFile, baseContent);

    // git diff --no-index exits code 1 when files differ — that's normal
    const result = await execGitWithAllowedExitCodes(
      repoDir,
      ['diff', '--no-index', '--', tempFile, fullPath],
      [0, 1]
    );

    const output = result.stdout;
    if (!output) {
      return '';
    }

    // Post-process: fix paths in the diff header only (before the first @@ hunk)
    const lines = output.split('\n');
    let pastHeader = false;
    const fixedLines = lines.map((line) => {
      if (!pastHeader && line.startsWith('@@')) {
        pastHeader = true;
      }
      if (!pastHeader) {
        if (line.startsWith('diff --git')) {
          return `diff --git a/${filePath} b/${filePath}`;
        }
        if (line.startsWith('--- ')) {
          return `--- a/${filePath}`;
        }
        if (line.startsWith('+++ ')) {
          return `+++ b/${filePath}`;
        }
      }
      return line;
    });

    return fixedLines.join('\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Gets the diff for all modified files, including untracked (new) files.
 * @param repoDir - Repository directory
 * @returns Diff content
 */
export async function getAllDiff(repoDir: string): Promise<string> {
  await ensureGit();

  // Get diff for tracked files
  const trackedDiff = await git(['diff', 'HEAD'], repoDir);

  // Get untracked files (properly expanded, not directories)
  const untrackedFiles = await getUntrackedFiles(repoDir);

  // Generate diffs for untracked files
  const untrackedDiffs: string[] = [];
  for (const file of untrackedFiles) {
    const diff = (await isBinaryFile(repoDir, file))
      ? await generateBinaryFilePatch(repoDir, file)
      : await generateNewFileDiff(repoDir, file);
    untrackedDiffs.push(diff);
  }

  // Combine all diffs — each already ends with \n, so concatenate directly
  // to avoid inserting blank lines between diff sections.
  const allDiffs = [trackedDiff, ...untrackedDiffs].filter((d) => d.trim().length > 0);
  const combined = allDiffs.join('');
  return combined.endsWith('\n') ? combined : combined + '\n';
}

/**
 * Splits a combined `git diff` body into one string per file section,
 * preserving exact bytes. A section runs from a column-0 `diff --git ` line up
 * to (but not including) the next such line. Boundary detection is anchored to
 * column 0 because every diff *body* line is prefixed by a space, `+`, `-`,
 * `\`, or `@`, so a context or added line that merely contains the text
 * `diff --git` can never be mistaken for a header. Paths are deliberately NOT
 * parsed out of the header here — see {@link buildTrackedSections}.
 * @param combined - Combined `git diff` stdout
 * @returns File sections in git's emission order
 */
function splitDiffSections(combined: string): string[] {
  const marker = 'diff --git ';
  const sections: string[] = [];
  let start = -1;
  for (let i = 0; i < combined.length; i++) {
    if ((i === 0 || combined[i - 1] === '\n') && combined.startsWith(marker, i)) {
      if (start !== -1) sections.push(combined.slice(start, i));
      start = i;
    }
  }
  if (start !== -1) sections.push(combined.slice(start, combined.length));
  return sections;
}

/**
 * Runs one `git diff --no-renames HEAD` over the tracked files (chunked under
 * ARG_MAX) and returns a `Map<path, section>` whose sections are byte-identical
 * to the per-file `git diff HEAD -- <file>` they replace.
 *
 * `--no-renames` is load-bearing: a multi-path diff under a user's
 * `diff.renames=true`/`=copies` could otherwise emit a single 2-path rename
 * section (`a/<old> b/<new>`) that a single-path `git diff HEAD -- <file>` can
 * never produce; `--no-renames` re-splits it into the same delete + add bytes
 * the per-file loop emitted.
 *
 * Sections are attributed to paths by POSITION against a companion
 * `git diff --no-renames HEAD -z --name-only` (raw, unquoted, NUL-delimited
 * paths, emitted in the same order as the sections) — never by parsing the
 * `diff --git` header, which is ambiguous or unparseable under `core.quotePath`
 * (non-ASCII paths are C-quoted), paths containing spaces, or
 * `diff.noprefix`/`diff.mnemonicPrefix`. If the section and name counts ever
 * disagree (an unmodeled config), that chunk falls back to per-file
 * {@link getFileDiff} so no file's diff is ever silently dropped.
 * @param repoDir - Repository directory
 * @param trackedFiles - Repo-relative files known to exist in HEAD
 * @returns Map from path to its exact diff section (changed files only)
 */
async function buildTrackedSections(
  repoDir: string,
  trackedFiles: string[]
): Promise<Map<string, string>> {
  const sectionsByPath = new Map<string, string>();
  for (const chunk of chunkPathspecs(trackedFiles)) {
    const combined = await git(['diff', '--no-renames', 'HEAD', '--', ...chunk], repoDir);
    const namesOutput = await git(
      ['diff', '--no-renames', 'HEAD', '-z', '--name-only', '--', ...chunk],
      repoDir
    );
    const names = namesOutput.split('\0').filter((name) => name.length > 0);
    const sections = splitDiffSections(combined);

    if (sections.length === names.length) {
      for (let i = 0; i < names.length; i++) {
        // Exact-path keys (raw git bytes, same encoding as the inputs) — never
        // a substring/startsWith match, so `foo.txt` cannot capture
        // `foo.txt.bak`'s section.
        sectionsByPath.set(names[i] as string, sections[i] as string);
      }
      continue;
    }

    // Counts disagree — recover the exact pre-batch per-file bytes for this
    // chunk rather than risk dropping or mis-keying a section.
    for (const file of chunk) {
      const diff = await getFileDiff(repoDir, file);
      if (diff.trim()) sectionsByPath.set(file, diff);
    }
  }
  return sectionsByPath;
}

/**
 * Builds a combined diff against HEAD for the provided files without touching
 * the real git index. Tracked files use `git diff HEAD`; untracked files use
 * synthesized new-file diffs.
 *
 * Performance: the work is batched into a handful of `git` invocations
 * (one `ls-tree` to classify, one `diff` over all tracked files, one
 * `hash-object` over all new text files) rather than the ~2 spawns per file the
 * previous per-file loop issued — that fan-out dominated the cold-run cost on a
 * Firefox-sized checkout (~700 serial spawns, ~99s). Binary, directory, and
 * recursion paths stay per-file because they are rare and (for binary) mutate
 * the index.
 * @param repoDir - Repository directory
 * @param files - File paths to diff (relative to repo root)
 * @returns Combined diff content
 */
export async function getDiffForFilesAgainstHead(
  repoDir: string,
  files: string[]
): Promise<string> {
  await ensureGit();

  // Expand any directory entries (paths ending with `/`) into their
  // individual untracked files before diffing. `git status --porcelain=v1`
  // reports collapsed untracked directories as `?? dir/`, and every caller
  // that feeds the aggregate working-tree state into this function must
  // not trigger an EISDIR when the diff pass reads `dir/` as if it were a
  // file. Belt-and-suspenders: the caller-side expansion in `lint.ts`
  // and `export-all.ts` covers the common path, but a single bad call
  // site re-introduced the bug in 0.17.0 — guarding here makes the
  // regression impossible at this layer.
  const expandedFiles: string[] = [];
  for (const file of files) {
    if (file.endsWith('/')) {
      const inner = await getUntrackedFilesInDir(repoDir, file);
      for (const entry of inner) expandedFiles.push(entry);
      continue;
    }
    expandedFiles.push(file);
  }

  const uniqueFiles = [...new Set(expandedFiles)].sort();
  if (uniqueFiles.length === 0) return '';

  // Batch 1: classify tracked-vs-new for the whole set in one `ls-tree` pass,
  // replacing one `fileExistsInHead` spawn per file.
  const tracked = await listTrackedInHead(repoDir, uniqueFiles);

  // Batch 2: one diff over every tracked file, split back to exact per-file
  // sections keyed by path.
  const trackedSections = await buildTrackedSections(
    repoDir,
    uniqueFiles.filter((file) => tracked.has(file))
  );

  // Classify the non-tracked files. Directory and binary entries keep their
  // per-file handling (rare, and binary patches mutate the index so they must
  // stay serial); plain new text files are collected for a single batched
  // `git hash-object`. Results land in `sectionByFile`, keyed by path, to be
  // emitted in sorted order below.
  const sectionByFile = new Map<string, string>();
  const newTextFiles: string[] = [];
  for (const file of uniqueFiles) {
    if (tracked.has(file)) continue;

    const fullPath = join(repoDir, file);
    if (!(await pathExists(fullPath))) {
      continue;
    }

    // Second defence against the EISDIR regression: a non-HEAD path
    // that exists on disk is usually a new file, but can also be a
    // directory that arrived without the trailing slash
    // `expandUntrackedDirectoryEntries` would have produced (caller
    // stripped it, submodule entry, tracked-file-replaced-by-dir).
    // Expand it via the same helper used by the slash branch and
    // recurse so each contained file is diffed individually; fail
    // loud when the directory has no readable content rather than
    // silently skipping it.
    const fileStat = await stat(fullPath);
    if (fileStat.isDirectory()) {
      const innerFiles = await getUntrackedFilesInDir(repoDir, file);
      if (innerFiles.length === 0) {
        throw new GitError(
          `'${file}' is a directory with no untracked content (submodule or gitignored?) — cannot diff as a file`,
          `ls-files --others -- ${file}`
        );
      }
      const innerDiff = await getDiffForFilesAgainstHead(repoDir, innerFiles);
      if (innerDiff.trim()) sectionByFile.set(file, innerDiff);
      continue;
    }

    if (await isBinaryFile(repoDir, file)) {
      const diff = await generateBinaryFilePatch(repoDir, file);
      if (diff.trim()) sectionByFile.set(file, diff);
      continue;
    }

    newTextFiles.push(file);
  }

  // Batch 3: blob hashes for every new text file in one `git hash-object`.
  // A miss (rare: a path became unreadable after the stat above) falls back to
  // the zero hash with the same verbose log the per-file path emitted.
  const blobHashes = await hashObjectBatch(
    repoDir,
    newTextFiles.map((file) => join(repoDir, file))
  );
  for (const file of newTextFiles) {
    const fullPath = join(repoDir, file);
    const fullHash = blobHashes.get(fullPath);
    if (fullHash === undefined) {
      verbose(`git hash-object failed for ${file}; falling back to zero blob hash`);
    }
    const body = buildNewFileDiffBody(file, await readText(fullPath), abbreviateBlobHash(fullHash));
    if (body.trim()) sectionByFile.set(file, body);
  }

  // Reassemble in the sorted `uniqueFiles` order — NOT git's section order,
  // which uses git's own collation and diverges from JS `.sort()` for
  // non-ASCII paths. Driving emission off `uniqueFiles` (as the previous
  // per-file loop did) keeps the combined output byte-identical. Do not change
  // this to push sections in git's emission order.
  const diffs: string[] = [];
  for (const file of uniqueFiles) {
    const section = trackedSections.get(file) ?? sectionByFile.get(file);
    if (section && section.trim()) diffs.push(section);
  }

  if (diffs.length === 0) {
    return '';
  }

  // Each diff from git already ends with \n. Concatenate directly to
  // preserve context lines (including trailing whitespace-only context)
  // and avoid inserting blank lines between diff sections.
  const combined = diffs.join('');
  return combined.endsWith('\n') ? combined : combined + '\n';
}

/**
 * Generates a combined diff for staged files against HEAD.
 * @param repoDir - Repository directory
 * @param files - File paths to diff (relative to repo)
 * @returns Diff content for the staged files
 */
export async function getStagedDiffForFiles(repoDir: string, files: string[]): Promise<string> {
  await ensureGit();
  return git(['diff', '--cached', 'HEAD', '--', ...files], repoDir);
}

/**
 * Serializes the index-mutating untracked-binary path. The bounded per-patch
 * lint pool can call {@link getDiffForFilesAgainstHead} (and thus this) for
 * several patches at once; two concurrent `git add --intent-to-add` / `git
 * reset` sequences would collide on `.git/index.lock` (a hard failure) or
 * interleave one file's stage with another's unstage. This process-level
 * promise chain runs the staging sequences one at a time. Read-only callers
 * (`git diff --binary HEAD`) do not need it. Binary patches are rare, so the
 * serialization cost is negligible.
 */
let binaryStagingLock: Promise<unknown> = Promise.resolve();
function runWithBinaryStagingLock<T>(task: () => Promise<T>): Promise<T> {
  const result = binaryStagingLock.then(task, task);
  binaryStagingLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Generates a GIT binary patch for a binary file.
 * For tracked files, uses `git diff --binary HEAD`.
 * For untracked files, temporarily stages with `--intent-to-add` to produce a diff.
 * @param repoDir - Repository directory
 * @param filePath - File path (relative to repo root)
 * @returns The binary diff string, or empty string if no diff
 */
export async function generateBinaryFilePatch(repoDir: string, filePath: string): Promise<string> {
  await ensureGit();

  // Try tracked file diff first (read-only — no index lock needed)
  const result = await execGitWithAllowedExitCodes(repoDir, [
    'diff',
    '--binary',
    'HEAD',
    '--',
    filePath,
  ]);
  if (result.stdout.trim()) return result.stdout;

  // For untracked files, stage temporarily to produce a binary diff. The
  // stage/unstage pair mutates the index, so it must not interleave with
  // another concurrent binary patch (see runWithBinaryStagingLock).
  return runWithBinaryStagingLock(async () => {
    try {
      await execGitWithAllowedExitCodes(repoDir, ['add', '--intent-to-add', '--', filePath]);
      const diffResult = await execGitWithAllowedExitCodes(repoDir, [
        'diff',
        '--binary',
        '--',
        filePath,
      ]);
      return diffResult.stdout;
    } finally {
      // Always unstage, even if diff fails
      await execGitWithAllowedExitCodes(repoDir, ['reset', 'HEAD', '--', filePath]);
    }
  });
}
