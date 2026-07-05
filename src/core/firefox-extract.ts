// SPDX-License-Identifier: EUPL-1.2
/**
 * Firefox source extraction and installed version detection.
 */

import { join } from 'node:path';

import { ExtractionError } from '../errors/download.js';
import { elapsedSince } from '../utils/elapsed.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { exec, execStream,executableExists } from '../utils/process.js';

/**
 * Returns true when an archive member path could land outside the
 * extraction root: absolute (POSIX or Windows drive/backslash rooted) or
 * containing a `..` segment.
 */
function isUnsafeArchivePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.split(/[\\/]/).includes('..');
}

/**
 * Validates entry names from a `tar -tf` listing.
 * @param names - Listing lines (one member name per line)
 * @returns The first unsafe member name, or null when all are safe
 */
export function findUnsafeArchiveEntryName(names: readonly string[]): string | null {
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    if (isUnsafeArchivePath(name)) return name;
  }
  return null;
}

/**
 * Validates symlink and hardlink targets from a `tar -tvf` listing.
 *
 * A relative link target without `..` segments can only resolve inside the
 * extraction root, so only absolute or `..`-containing targets are rejected.
 * Symlinks are `l`-typed lines with a ` -> target` suffix (the LAST arrow is
 * taken, so a link whose own name contains ` -> ` still parses to its real
 * target); hardlinks print ` link to target` on GNU tar and bsdtar alike.
 *
 * @param verboseLines - `tar -tvf` listing lines
 * @returns A description of the first unsafe link found, or null
 */
export function findUnsafeArchiveLink(verboseLines: readonly string[]): string | null {
  for (const line of verboseLines) {
    if (line.startsWith('l')) {
      const arrow = line.lastIndexOf(' -> ');
      if (arrow !== -1) {
        const target = line.slice(arrow + 4).trim();
        if (isUnsafeArchivePath(target)) return `symlink target: ${target}`;
        continue;
      }
    }
    const hardlink = line.lastIndexOf(' link to ');
    if (hardlink !== -1) {
      const target = line.slice(hardlink + 9).trim();
      if (isUnsafeArchivePath(target)) return `hardlink target: ${target}`;
    }
  }
  return null;
}

/**
 * Lists the archive and rejects members that could escape the extraction
 * root before anything is written to disk: absolute names, `..` traversal,
 * and symlink/hardlink targets that are absolute or `..`-escaping. Modern
 * GNU tar / bsdtar refuse most of these at extraction time; the preflight
 * makes the guarantee explicit and independent of the host tar's defaults.
 *
 * Two listings are needed because they answer different questions and
 * neither is safe to derive from the other: member names come from `-tf`,
 * where the whole line IS the name, while link targets only appear in
 * `-tvf`. Names are deliberately NOT parsed out of the `-tvf` columns — the
 * adjacent uname/gname fields are attacker-controlled in a crafted archive,
 * so a date-shaped owner name could shift the column boundary and hide an
 * absolute member name from the check. Each listing pass costs one full
 * decompression, so the two run concurrently and overlap almost perfectly
 * (they are CPU-bound on separate cores). Measured on a real Firefox ESR
 * 140.9 source tarball (601 MB, bsdtar 3.5.3, macOS): -tf 21.7 s, -tvf
 * 22.1 s, both concurrent 22 s wall, extraction itself 58 s (file-creation
 * syscalls dominate it, not decompression) — so the preflight adds ~22 s
 * (~38%) to this one-time extraction step, versus ~44 s if run
 * sequentially.
 */
/**
 * Incremental line splitter for streamed listings. Keeps only the current
 * partial line in memory, so a 350k-entry Firefox listing costs O(longest
 * line), not O(listing).
 */
function createLineScanner(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = '';
      }
    },
  };
}

/**
 * Runs one tar listing pass, streaming lines through `checkLine` and
 * returning the first unsafe finding (or null) plus the exit code.
 *
 * Streaming matters for safety, not just memory: the buffered `exec`
 * collector silently truncates at 50 MB, and a full Firefox `-tvf` listing
 * already sits in the 40–50 MB range — so the buffered implementation could
 * scan only the head of the listing while reporting the archive safe. A
 * crafted archive could exploit exactly that by padding benign entries
 * first and hiding a traversal name or absolute link target past the cap.
 * With per-line streaming EVERY entry is scanned, with bounded memory.
 */
async function runListingScan(
  archivePath: string,
  tarFlag: '-tf' | '-tvf',
  checkLine: (line: string) => string | null
): Promise<{ unsafe: string | null; exitCode: number; stderrTail: string }> {
  // LC_ALL=C keeps the -tvf column format stable for the link parse.
  const listEnv = { LC_ALL: 'C', LANG: 'C' };
  let unsafe: string | null = null;
  let stderrTail = '';

  const scanner = createLineScanner((line) => {
    if (unsafe === null) {
      unsafe = checkLine(line);
    }
  });

  const exitCode = await execStream('tar', [tarFlag, archivePath], {
    env: listEnv,
    onStdout: (chunk) => {
      scanner.push(chunk);
    },
    onStderr: (chunk) => {
      // Keep a small diagnostic tail; the listing itself is the big stream.
      stderrTail = (stderrTail + chunk).slice(-4096);
    },
  });
  scanner.flush();

  return { unsafe, exitCode, stderrTail };
}

async function preflightArchiveEntries(archivePath: string): Promise<void> {
  const [nameScan, linkScan] = await Promise.all([
    runListingScan(archivePath, '-tf', (line) => {
      const name = line.trim();
      if (name.length === 0) return null;
      return isUnsafeArchivePath(name) ? name : null;
    }),
    runListingScan(archivePath, '-tvf', (line) => findUnsafeArchiveLink([line])),
  ]);

  if (nameScan.exitCode !== 0) {
    throw new ExtractionError(
      archivePath,
      new Error(`tar -tf preflight exited with code ${nameScan.exitCode}:\n${nameScan.stderrTail}`)
    );
  }
  if (nameScan.unsafe !== null) {
    throw new ExtractionError(
      archivePath,
      new Error(
        `Archive rejected: member name could escape the extraction root: ${nameScan.unsafe}`
      )
    );
  }

  if (linkScan.exitCode !== 0) {
    throw new ExtractionError(
      archivePath,
      new Error(`tar -tvf preflight exited with code ${linkScan.exitCode}:\n${linkScan.stderrTail}`)
    );
  }
  if (linkScan.unsafe !== null) {
    throw new ExtractionError(
      archivePath,
      new Error(`Archive rejected: link could escape the extraction root (${linkScan.unsafe})`)
    );
  }
}

/**
 * Extracts a tar.xz archive after a listing preflight that rejects
 * path-traversal member names and escaping link targets.
 * @param archivePath - Path to the archive
 * @param destDir - Destination directory
 */
export async function extractTarXz(
  archivePath: string,
  destDir: string,
  onProgress?: (message: string) => void
): Promise<void> {
  if (!(await executableExists('tar'))) {
    throw new ExtractionError(
      archivePath,
      new Error(
        'The "tar" command was not found. Please install tar (or ensure it is on your PATH) and try again.'
      )
    );
  }

  await ensureDir(destDir);

  const startedAt = Date.now();
  onProgress?.(`Validating source archive entries (${elapsedSince(startedAt)} elapsed)...`);
  const heartbeat = onProgress
    ? setInterval(() => {
        onProgress(`Extracting source archive (${elapsedSince(startedAt)} elapsed)...`);
      }, 15_000)
    : null;
  heartbeat?.unref();

  try {
    await preflightArchiveEntries(archivePath);

    onProgress?.(`Extracting source archive (${elapsedSince(startedAt)} elapsed)...`);
    const result = await exec('tar', ['-xf', archivePath, '-C', destDir]);

    if (result.exitCode !== 0) {
      throw new ExtractionError(
        archivePath,
        new Error(`tar exited with code ${result.exitCode}:\n${result.stderr}`)
      );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  onProgress?.(`Source archive extracted (${elapsedSince(startedAt)} elapsed)`);
}

/**
 * Gets the Firefox version from an existing source directory.
 * @param engineDir - Path to the engine directory
 * @returns Firefox version string
 */
export async function getFirefoxVersion(engineDir: string): Promise<string | undefined> {
  const versionPath = join(engineDir, 'browser', 'config', 'version.txt');

  if (!(await pathExists(versionPath))) {
    return undefined;
  }

  const { readText } = await import('../utils/fs.js');
  const version = await readText(versionPath);
  return version.trim();
}

/**
 * Formats bytes into a human-readable string.
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 GB")
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
