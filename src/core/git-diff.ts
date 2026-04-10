// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { GitError } from '../errors/git.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { ensureGit, git } from './git-base.js';
import { fileExistsInHead } from './git-file-ops.js';
import { getUntrackedFiles } from './git-status.js';

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
 * Generates a unified diff for a new (untracked) file.
 * @param repoDir - Repository directory
 * @param filePath - Path to the file (relative to repo)
 * @returns Diff content in unified diff format
 */
export async function generateNewFileDiff(repoDir: string, filePath: string): Promise<string> {
  const fullPath = join(repoDir, filePath);
  const content = await readText(fullPath);

  // Compute the abbreviated git blob hash for the index line
  let blobHash = '0000000000';
  try {
    const fullHash = (await git(['hash-object', fullPath], repoDir)).trim();
    if (fullHash.length >= 10) {
      blobHash = fullHash.slice(0, 10);
    }
  } catch (error: unknown) {
    verbose(
      `git hash-object failed for ${filePath}; falling back to zero blob hash: ${toError(error).message}`
    );
  }

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
    const diff = await generateNewFileDiff(repoDir, file);
    untrackedDiffs.push(diff);
  }

  // Combine all diffs — each already ends with \n, so concatenate directly
  // to avoid inserting blank lines between diff sections.
  const allDiffs = [trackedDiff, ...untrackedDiffs].filter((d) => d.trim().length > 0);
  const combined = allDiffs.join('');
  return combined.endsWith('\n') ? combined : combined + '\n';
}

/**
 * Builds a combined diff against HEAD for the provided files without touching
 * the real git index. Tracked files use `git diff HEAD`; untracked files use
 * synthesized new-file diffs.
 * @param repoDir - Repository directory
 * @param files - File paths to diff (relative to repo root)
 * @returns Combined diff content
 */
export async function getDiffForFilesAgainstHead(
  repoDir: string,
  files: string[]
): Promise<string> {
  await ensureGit();

  const uniqueFiles = [...new Set(files)].sort();
  const diffs: string[] = [];

  for (const file of uniqueFiles) {
    if (await fileExistsInHead(repoDir, file)) {
      const diff = await getFileDiff(repoDir, file);
      if (diff.trim()) {
        diffs.push(diff);
      }
      continue;
    }

    if (!(await pathExists(join(repoDir, file)))) {
      continue;
    }

    const diff = await generateNewFileDiff(repoDir, file);
    if (diff.trim()) {
      diffs.push(diff);
    }
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
 * Generates a GIT binary patch for a binary file.
 * For tracked files, uses `git diff --binary HEAD`.
 * For untracked files, temporarily stages with `--intent-to-add` to produce a diff.
 * @param repoDir - Repository directory
 * @param filePath - File path (relative to repo root)
 * @returns The binary diff string, or empty string if no diff
 */
export async function generateBinaryFilePatch(repoDir: string, filePath: string): Promise<string> {
  await ensureGit();

  // Try tracked file diff first
  const result = await execGitWithAllowedExitCodes(repoDir, [
    'diff',
    '--binary',
    'HEAD',
    '--',
    filePath,
  ]);
  if (result.stdout.trim()) return result.stdout;

  // For untracked files, stage temporarily to produce a binary diff
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
}
