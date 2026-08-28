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
import { mintDisposableGitIndex, readOnlyGitIndexEnv } from './git-readonly-index.js';
import { getUntrackedFiles, getUntrackedFilesInDir } from './git-status.js';

async function execGitWithAllowedExitCodes(
  repoDir: string,
  args: string[],
  allowedExitCodes: number[] = [0],
  envOverride?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Honour a read-only command's private-index scope: the `--intent-to-add`
  // / `update-index` staging dance below is a genuine
  // index write, and inside a read-only command it must land on the
  // private index, not the primary checkout's.
  //
  // `envOverride` wins over that scope: a caller that minted an index for
  // one specific invocation has said something more specific than the
  // ambient scope did.
  const readOnlyIndexEnv = readOnlyGitIndexEnv(repoDir);
  const env =
    readOnlyIndexEnv !== undefined || envOverride !== undefined
      ? { ...readOnlyIndexEnv, ...envOverride }
      : undefined;
  const result = await exec('git', args, {
    cwd: repoDir,
    ...(env !== undefined ? { env } : {}),
  });
  if (allowedExitCodes.includes(result.exitCode)) {
    return result;
  }

  throw new GitError(result.stderr.trim() || 'Git command failed', args.join(' '));
}

/**
 * Gets the diff for a specific file.
 *
 * `--binary` is load-bearing: without it git degrades a binary file's section
 * to the informational `Binary files a/x and b/x differ`, which carries none
 * of the bytes and cannot be replayed by `git apply`. It only expands the
 * BINARY section's index line to full hashes (text sections keep their
 * abbreviated form), so text output stays byte-identical.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns Diff content
 */
export async function getFileDiff(repoDir: string, filePath: string): Promise<string> {
  await ensureGit();
  return git(['diff', '--binary', 'HEAD', '--', filePath], repoDir);
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
 * Pure formatter for a new (untracked) file's unified diff. Shared by the
 * batched cold-run path in {@link getDiffForFilesAgainstHead} and the
 * standalone {@link generateNewFileDiff} — the only thing that differs is
 * where `blobHash` comes from (a single batched `git hash-object` vs a
 * per-file one), never the formatting. Preserves the empty-file form, the
 * trailing-newline handling, and the "No newline at end of file" marker
 * byte-for-byte.
 *
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

  // Defensive check: a directory here means a caller bypassed the expansion
  // layers and handed the leaf reader a path it cannot read. Surface it with
  // an actionable message naming the offending path rather than the raw
  // `EISDIR` that `readText` would throw.
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
 *
 * Tracked binary files round-trip through `git diff --binary`; untracked ones
 * go through {@link generateBinaryFilePatch} below. Both arms must stay
 * binary-aware — see {@link getFileDiff} for why.
 * @param repoDir - Repository directory
 * @returns Diff content
 */
export async function getAllDiff(repoDir: string): Promise<string> {
  await ensureGit();

  // Get diff for tracked files
  const trackedDiff = await git(['diff', '--binary', 'HEAD'], repoDir);

  // Get untracked files (properly expanded, not directories)
  const untrackedFiles = await getUntrackedFiles(repoDir);

  // Classify first. `isBinaryFile` reads the file's first 8 KB directly and
  // spawns nothing, so the only per-file process in this loop is the
  // `git hash-object` inside `generateNewFileDiff` — one spawn per untracked
  // TEXT file, uncapped, against a Firefox tree where "untracked" can mean a
  // very large number. Hence classify → one batched hash → render.
  //
  // Everything else here is deliberately untouched: `git diff HEAD` (with
  // renames, unlike the `--no-renames` scoped sibling), the `ls-files`
  // ordering, tracked-block-first emission, and the `'\n'` empty-result
  // sentinel are all observable. `getAllDiff`'s output is SHA-256'd into
  // every tree fingerprint (tree-store.ts) and written verbatim into `.patch`
  // files (export-all.ts), so its bytes are a contract.
  const binaryFiles: string[] = [];
  const textFiles: string[] = [];
  for (const file of untrackedFiles) {
    if (await isBinaryFile(repoDir, file)) {
      binaryFiles.push(file);
    } else {
      textFiles.push(file);
    }
  }

  const textHashes = await hashObjectBatch(
    repoDir,
    textFiles.map((file) => join(repoDir, file))
  );

  // Binary patches stage into the index and must stay serial; text patches
  // are pure formatting over the already-batched hashes.
  const binaryDiffs = new Map<string, string>();
  for (const file of binaryFiles) {
    binaryDiffs.set(file, await generateBinaryFilePatch(repoDir, file));
  }

  const untrackedDiffs: string[] = [];
  for (const file of untrackedFiles) {
    const binary = binaryDiffs.get(file);
    if (binary !== undefined) {
      untrackedDiffs.push(binary);
      continue;
    }
    const fullPath = join(repoDir, file);
    // Same defensive directory check `generateNewFileDiff` carries: a
    // directory here means a caller bypassed the expansion layers, and its
    // comment records this as a recurring bug class.
    const fileStat = await stat(fullPath);
    if (fileStat.isDirectory()) {
      throw new GitError(
        `expected a file but found a directory at '${file}' — caller must expand directory entries before diffing`,
        `hash-object ${file}`
      );
    }
    const content = await readText(fullPath);
    untrackedDiffs.push(
      buildNewFileDiffBody(file, content, abbreviateBlobHash(textHashes.get(fullPath)))
    );
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
 * Runs one `git diff --binary --no-renames HEAD` over the tracked files
 * (chunked under ARG_MAX) and returns a `Map<path, section>` whose sections are
 * byte-identical to the per-file `git diff --binary HEAD -- <file>` they
 * replace.
 *
 * `--binary` is load-bearing: a tracked binary file would otherwise degrade to
 * the un-appliable `Binary files a/x and b/x differ` stub. It expands only the
 * binary section's index line to full hashes, so text sections are unaffected
 * — see {@link getFileDiff}.
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
    const combined = await git(
      ['diff', '--binary', '--no-renames', 'HEAD', '--', ...chunk],
      repoDir
    );
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
 * the real git index. Tracked files use `git diff --binary HEAD` (binary
 * sections included); untracked files use synthesized new-file diffs, or
 * {@link generateBinaryFilePatch} when the file is binary.
 *
 * Performance: the work is batched into a handful of `git` invocations (one
 * `ls-tree` to classify, one `diff` over all tracked files, one `hash-object`
 * over all new text files) rather than ~2 spawns per file, which dominates
 * the cold-run cost on a Firefox-sized checkout. Binary, directory, and
 * recursion paths stay per-file because they are rare and (for binary)
 * mutate the index.
 *
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
  // that feeds the aggregate working-tree state into this function must not
  // trigger an EISDIR when the diff pass reads `dir/` as if it were a file.
  // The caller-side expansion in `lint.ts` and `export-all.ts` covers the
  // common path; guarding here makes a single bad call site harmless.
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

    // Second defence against EISDIR: a non-HEAD path that exists on disk is
    // usually a new file, but can also be a directory that arrived without
    // the trailing slash `expandUntrackedDirectoryEntries` would have
    // produced (caller stripped it, submodule entry, tracked-file-replaced-
    // by-dir). Expand it via the same helper used by the slash branch and
    // recurse so each contained file is diffed individually; fail loud when
    // the directory has no readable content rather than silently skipping it.
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
  return git(['diff', '--binary', '--cached', 'HEAD', '--', ...files], repoDir);
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

  // The diff for an untracked file has to come from an index entry, so one
  // has to be written. Writing it to a PRIVATE index is what keeps that
  // write invisible: the primary `.git/index` never moves, so a concurrent
  // `fireforge test` fingerprinting `engine/` with `git status` cannot
  // observe the transient `--intent-to-add` entry and void its own verdict
  // on our bookkeeping. That was a real failure mode — parallel gate lanes
  // killed three runs with `FAIL reason=inconclusive` on branding PNGs
  // flapping between `A` and `??`.
  //
  // Nothing is restored afterwards because nothing shared was changed, and
  // no lock is taken because two concurrent callers get two indexes. Both
  // the restore dance and the in-process lock survive below purely for the
  // fallback, where the primary index really is the one being written.
  const disposable = await mintDisposableGitIndex(repoDir);
  if (disposable !== undefined) {
    try {
      await execGitWithAllowedExitCodes(
        repoDir,
        ['add', '--intent-to-add', '--', filePath],
        [0],
        disposable.env
      );
      const diffResult = await execGitWithAllowedExitCodes(
        repoDir,
        ['diff', '--binary', '--', filePath],
        [0],
        disposable.env
      );
      return diffResult.stdout;
    } finally {
      await disposable.dispose();
    }
  }

  // Fallback: no private index could be minted (a non-git directory, an
  // unreadable index, no writable tmpdir). Degrading to the shared index is
  // the pre-existing behaviour rather than a new risk, and refusing instead
  // would fail an export over an optimisation. The stage/unstage pair
  // mutates the index, so it must not interleave with another concurrent
  // binary patch (see runWithBinaryStagingLock).
  verbose(`Binary patch for ${filePath} is staging on the shared index (no private index).`);
  return runWithBinaryStagingLock(async () => {
    // Snapshot the path's exact index entry before touching it. A blanket
    // `git reset HEAD -- <file>` cleanup restores the path to its HEAD state
    // — for a path absent from HEAD that means *removing* whatever entry the
    // index carried, silently discarding any staged state that arrived
    // between the read-only diff above and this staging block (a concurrent
    // writer, or a staged-add whose worktree file was deleted). Restoring
    // the captured entry is exact regardless of how the entry got there.
    const priorEntry = (
      await execGitWithAllowedExitCodes(repoDir, ['ls-files', '--stage', '--', filePath])
    ).stdout;
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
      await restoreIndexEntry(repoDir, filePath, priorEntry);
    }
  });
}

/**
 * Restores a path's index entry to a previously captured `ls-files --stage`
 * snapshot after a temporary `--intent-to-add` staging. No prior entry means
 * the temporary entry is dropped via `reset HEAD` (the path's HEAD state IS
 * "absent" — this branch only runs for files untracked in HEAD). A prior
 * stage-0 entry is re-pointed at its recorded mode and blob. Unmerged entries
 * (stages 1–3) cannot be rebuilt through `--cacheinfo`; that degenerate state
 * keeps the legacy reset-to-HEAD behavior rather than corrupting the conflict.
 * @param repoDir - Repository directory
 * @param filePath - File path (relative to repo root)
 * @param priorEntry - Raw `git ls-files --stage -- <file>` output from before staging
 */
async function restoreIndexEntry(
  repoDir: string,
  filePath: string,
  priorEntry: string
): Promise<void> {
  const entryMatch = /^(\d{6}) ([0-9a-f]{4,64}) 0\t/.exec(priorEntry.trim());
  const mode = entryMatch?.[1];
  const oid = entryMatch?.[2];
  if (mode === undefined || oid === undefined) {
    await execGitWithAllowedExitCodes(repoDir, ['reset', 'HEAD', '--', filePath]);
    return;
  }
  await execGitWithAllowedExitCodes(repoDir, [
    'update-index',
    '--add',
    '--cacheinfo',
    `${mode},${oid},${filePath}`,
  ]);
}
