// SPDX-License-Identifier: EUPL-1.2
/**
 * The Firefox source archive of a pin: where Mozilla publishes it, the
 * verified copy in the host cache, and its extraction.
 *
 * The archive becomes the commit every owned change is measured against, so
 * its digest is always checked: against `firefox.sha256` when the project
 * pins one, otherwise against the `SHA256SUMS` Mozilla publishes beside it.
 * A digest that cannot be fetched fails the download unless the project
 * opted into `firefox.allowUnverifiedDownload`, and a cached archive records
 * how it was verified, so removing that opt-in re-verifies the cache.
 */
import { basename, dirname, join } from 'node:path';

import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import {
  ensureDir,
  listDir,
  makeTempDir,
  move,
  pathInfo,
  remove,
  writeFileFromStream,
} from '../kernel/fs.js';
import { hashFile } from '../kernel/hash.js';
import { readJsonIfExists, writeJson } from '../kernel/json.js';
import { verbose, warn } from '../kernel/log.js';
import { findExecutable, run } from '../kernel/process/index.js';
import { type Infer, s } from '../kernel/schema.js';
import { tailLines } from '../kernel/text.js';
import { sleep } from '../kernel/time.js';
import type { HostPaths } from '../project/index.js';
import type { FirefoxPin } from './pin.js';

/** Where a pin's source archive is published and what it is called in the cache. */
export interface SourceArchive {
  /** The archive's URL on archive.mozilla.org. */
  readonly url: string;
  /** Its file name in the host cache. A candidate build never shares one with the release. */
  readonly filename: string;
  /** The `SHA256SUMS` file of the same release directory. */
  readonly checksumsUrl: string;
  /** The archive's path as `SHA256SUMS` lists it. */
  readonly pathInChecksums: string;
}

/**
 * Resolves a pin to its source archive.
 *
 * @param pin - The pin
 */
export function sourceArchive(pin: FirefoxPin): SourceArchive {
  const base =
    pin.product === 'firefox-devedition'
      ? 'https://archive.mozilla.org/pub/devedition'
      : 'https://archive.mozilla.org/pub/firefox';
  const directory =
    pin.candidate === undefined
      ? `${base}/releases/${pin.version}`
      : `${base}/candidates/${pin.version}-candidates/${pin.candidate}`;
  const pathInChecksums = `source/firefox-${pin.version}.source.tar.xz`;
  const candidate = pin.candidate === undefined ? '' : `-${pin.candidate}`;
  return {
    url: `${directory}/${pathInChecksums}`,
    filename: `firefox-${pin.product}-${pin.version}${candidate}.source.tar.xz`,
    checksumsUrl: `${directory}/SHA256SUMS`,
    pathInChecksums,
  };
}

/** What a download can be told. */
export interface DownloadOptions {
  /** The network. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Receives one line per phase and per progress step. */
  onProgress?: (message: string) => void;
}

function downloadError(
  code: string,
  message: string,
  hint?: string,
  cause?: unknown
): FireForgeError {
  return new FireForgeError(code, message, {
    exitCode: ExitCode.DOWNLOAD_ERROR,
    ...(hint === undefined ? {} : { hint }),
    ...(cause === undefined ? {} : { cause }),
  });
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 3;

/** Timing of {@link fetchWithRetry}. */
export interface RetryOptions {
  fetch?: typeof fetch | undefined;
  /** Deadline of one attempt, covering the headers and `consume` (default 60 000). */
  timeoutMs?: number;
  /** Delay before the second attempt; it grows quadratically (default 1 000). */
  retryDelayMs?: number;
}

/**
 * Requests a URL and hands the response to `consume`, with one deadline over
 * both, up to three times. A 429 or 5xx status, a network failure, a failing
 * `consume` and an expired deadline are retried; any other response reaches
 * `consume` on the first attempt. The deadline holds even when the body
 * ignores the abort signal.
 *
 * @param url - What to request
 * @param consume - Reads the response; its result is returned
 * @param options - See {@link RetryOptions}
 * @throws `download-failed` (exit code 3) once every attempt has failed
 */
export async function fetchWithRetry<T>(
  url: string,
  consume: (response: Response) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let failure: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`the request or its response body timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        deadline,
        (async (): Promise<T> => {
          const response = await request(url, { signal: controller.signal });
          if (RETRYABLE_STATUS.has(response.status)) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
          }
          return consume(response);
        })(),
      ]);
    } catch (error: unknown) {
      // A refusal `consume` already worded is final: retrying cannot change it.
      if (error instanceof FireForgeError) throw error;
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < ATTEMPTS) await sleep((options.retryDelayMs ?? 1_000) * attempt ** 2);
  }
  throw downloadError(
    'download-failed',
    `Could not fetch ${url}: ${toError(failure).message}`,
    'Check the network connection and retry.',
    failure
  );
}

/** No data for this long ends a transfer. */
const STALL_MS = 30_000;

/** The body's chunks, failing when none arrives within `stallMs`. */
async function* unstalled(
  body: ReadableStream<Uint8Array>,
  url: string,
  stallMs: number,
  onChunk: (bytes: number) => void
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            downloadError(
              'download-failed',
              `The download of ${url} stalled: no data for ${Math.round(stallMs / 1000)} seconds`,
              'Retry the command; the transfer starts over.'
            )
          );
        }, stallMs);
      });
      const next = await Promise.race([reader.read(), stalled]).finally(() => {
        clearTimeout(timer);
      });
      if (next.done) return;
      onChunk(next.value.byteLength);
      yield next.value;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Downloads the archive to `target`, which appears only once the transfer is complete. */
async function downloadArchive(
  archive: SourceArchive,
  target: string,
  options: DownloadOptions
): Promise<number> {
  const response = await fetchWithRetry(archive.url, (reply) => Promise.resolve(reply), options);
  if (response.status === 404) {
    throw downloadError(
      'version-not-found',
      `Mozilla publishes no source archive at ${archive.url}`,
      'Check firefox.version, firefox.product and firefox.candidate in fireforge.json.'
    );
  }
  if (!response.ok || response.body === null) {
    throw downloadError(
      'download-failed',
      `Could not download ${archive.url}: HTTP ${response.status} ${response.statusText}`.trim()
    );
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let reported = 0;
  return writeFileFromStream(
    target,
    unstalled(response.body, archive.url, STALL_MS, (bytes) => {
      received += bytes;
      const tenth = total > 0 ? Math.floor((received / total) * 10) : 0;
      if (tenth > reported) {
        reported = tenth;
        options.onProgress?.(`Downloading ${archive.filename}: ${tenth * 10}%`);
      }
    })
  );
}

type PublishedDigest = { sha256: string } | { sha256: undefined; reason: string };

/** The digest `SHA256SUMS` lists for the archive, or why there is none. */
async function publishedDigest(
  archive: SourceArchive,
  options: DownloadOptions
): Promise<PublishedDigest> {
  let reply: { ok: boolean; status: number; body: string };
  try {
    reply = await fetchWithRetry(
      archive.checksumsUrl,
      async (response) => ({
        ok: response.ok,
        status: response.status,
        body: response.ok ? await response.text() : '',
      }),
      options
    );
  } catch (error: unknown) {
    return { sha256: undefined, reason: toError(error).message };
  }
  if (!reply.ok) return { sha256: undefined, reason: `HTTP ${reply.status} fetching SHA256SUMS` };
  for (const line of reply.body.split('\n')) {
    // `<digest>  <path>` or `<digest> *<path>`.
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] === archive.pathInChecksums) {
      return { sha256: match[1] };
    }
  }
  return {
    sha256: undefined,
    reason: `SHA256SUMS does not list ${archive.pathInChecksums} (the wrong file, or a response that is not Mozilla's)`,
  };
}

function mismatch(
  archive: SourceArchive,
  expected: string,
  actual: string,
  source: string
): FireForgeError {
  return downloadError(
    'checksum-mismatch',
    `${archive.filename} has SHA-256 ${actual}, but ${source} says ${expected}`,
    'The archive is not the one that was pinned or published. Do not build on it; retry the download, and check firefox.sha256.'
  );
}

/** How an archive's digest was authenticated. */
type Verification = 'pinned' | 'published' | 'unverified';

/** Holds a digest to the project's pin, or else to the published one. */
async function verifyDigest(
  archive: SourceArchive,
  pin: FirefoxPin,
  actual: string,
  options: DownloadOptions
): Promise<Verification> {
  if (pin.sha256 !== undefined) {
    if (actual !== pin.sha256) throw mismatch(archive, pin.sha256, actual, 'firefox.sha256');
    return 'pinned';
  }
  options.onProgress?.(`Verifying ${archive.filename} against the published SHA256SUMS`);
  const published = await publishedDigest(archive, options);
  if (published.sha256 !== undefined) {
    if (actual !== published.sha256) {
      throw mismatch(archive, published.sha256, actual, archive.checksumsUrl);
    }
    return 'published';
  }
  if (!pin.allowUnverifiedDownload) {
    throw downloadError(
      'checksum-unavailable',
      `Could not verify ${archive.filename}: ${published.reason} (${archive.checksumsUrl})`,
      'Retry when the SHA256SUMS file is reachable, pin firefox.sha256, or set firefox.allowUnverifiedDownload to trust TLS alone.'
    );
  }
  warn(
    `Could not verify ${archive.filename} against the published SHA256SUMS (${published.reason}). ` +
      'firefox.allowUnverifiedDownload is set, so the download is trusted on TLS alone.'
  );
  return 'unverified';
}

const ArchiveRecord = s.object({
  url: s.string(),
  size: s.int({ min: 0 }),
  sha256: s.string({ pattern: /^[a-f0-9]{64}$/ }),
  verification: s.enum(['pinned', 'published', 'unverified']),
  downloadedAt: s.string(),
});
type ArchiveRecord = Infer<typeof ArchiveRecord>;

/** The cached archive's record when the file on disk is the one it describes. */
async function validCacheEntry(
  archive: SourceArchive,
  path: string
): Promise<ArchiveRecord | undefined> {
  let record: ArchiveRecord | undefined;
  try {
    record = await readJsonIfExists(`${path}.json`, ArchiveRecord);
  } catch (error: unknown) {
    verbose(`Ignoring the cache record of ${path}: ${toError(error).message}`);
    return undefined;
  }
  const info = await pathInfo(path);
  if (record === undefined || info?.kind !== 'file') return undefined;
  if (record.url !== archive.url || record.size !== info.size) return undefined;
  return (await hashFile(path)) === record.sha256 ? record : undefined;
}

/**
 * The pin's source archive in the host cache, downloaded if it is not there
 * and verified either way. Callers serialise per pin; `ensurePristine` does.
 *
 * @param host - The host locations
 * @param pin - The pin
 * @param options - See {@link DownloadOptions}
 * @returns The archive's path
 * @throws `version-not-found`, `download-failed`, `checksum-mismatch` or
 *   `checksum-unavailable` (exit code 3)
 */
export async function ensureArchive(
  host: Pick<HostPaths, 'cache'>,
  pin: FirefoxPin,
  options: DownloadOptions = {}
): Promise<string> {
  const archive = sourceArchive(pin);
  const path = join(host.cache, archive.filename);
  const cached = await validCacheEntry(archive, path);
  if (cached !== undefined) {
    // A pin is checked on every use; a published digest once. An entry that
    // was accepted unverified is held to the current rule again.
    if (pin.sha256 !== undefined || cached.verification !== 'published') {
      const verification = await verifyDigest(archive, pin, cached.sha256, options);
      if (verification !== cached.verification) {
        await writeJson(`${path}.json`, { ...cached, verification });
      }
    }
    options.onProgress?.(`Using the cached ${archive.filename}`);
    return path;
  }
  await discardArchive(path);
  await ensureDir(host.cache);
  options.onProgress?.(`Downloading ${archive.url}`);
  const size = await downloadArchive(archive, path, options);
  try {
    const sha256 = await hashFile(path);
    const verification = await verifyDigest(archive, pin, sha256, options);
    const record: ArchiveRecord = {
      url: archive.url,
      size,
      sha256,
      verification,
      downloadedAt: new Date().toISOString(),
    };
    await writeJson(`${path}.json`, record);
  } catch (error: unknown) {
    await discardArchive(path);
    throw error;
  }
  return path;
}

/**
 * Removes an archive and its record from the cache.
 *
 * @param path - The archive's path
 */
async function discardArchive(path: string): Promise<void> {
  await remove(path);
  await remove(`${path}.json`);
}

function escapes(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.split(/[\\/]/).includes('..');
}

/**
 * Why a member name from a `tar -tf` listing must not be extracted, or
 * undefined: an absolute or `..` path lands outside the extraction root, and
 * a `.git` segment at any depth would seed configuration or hooks into the
 * repository the tree is about to become.
 *
 * @param name - One listing line
 */
export function unsafeArchiveMember(name: string): string | undefined {
  const member = name.trim();
  if (member === '') return undefined;
  if (escapes(member)) return `member ${member} leaves the extraction root`;
  return member.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')
    ? `member ${member} would seed a .git directory`
    : undefined;
}

/**
 * Why a line of a `tar -tvf` listing names a link that must not be
 * extracted, or undefined: a symlink (` -> target`) or hard link
 * (` link to target`) whose target is absolute or climbs with `..`.
 *
 * @param line - One verbose listing line
 */
export function unsafeArchiveLink(line: string): string | undefined {
  const arrow = line.startsWith('l') ? line.lastIndexOf(' -> ') : -1;
  const hard = line.lastIndexOf(' link to ');
  const target =
    arrow !== -1
      ? line.slice(arrow + 4).trim()
      : hard !== -1
        ? line.slice(hard + 9).trim()
        : undefined;
  return target !== undefined && escapes(target)
    ? `link target ${target} leaves the extraction root`
    : undefined;
}

function extractError(archivePath: string, why: string, hint?: string): FireForgeError {
  return downloadError(
    'extract-failed',
    `Could not extract ${basename(archivePath)}: ${why}`,
    hint ?? 'Retry the command; a damaged archive is downloaded again.'
  );
}

/**
 * Scans one listing of the archive. Member names come from `-tf`, where the
 * whole line is the name; link targets only appear in `-tvf`. Names are never
 * parsed out of the verbose columns, whose owner fields an archive controls.
 */
async function scanListing(
  archivePath: string,
  flag: '-tf' | '-tvf',
  check: (line: string) => string | undefined
): Promise<void> {
  let unsafe: string | undefined;
  const listing = await run('tar', [flag, archivePath], {
    env: { LC_ALL: 'C', LANG: 'C' },
    onLine: (line, stream) => {
      if (stream === 'stdout') unsafe ??= check(line);
    },
  });
  if (listing.exitCode !== 0) {
    const tail = tailLines(listing.stderr, 5).join('\n');
    throw extractError(archivePath, `tar ${flag} exited ${listing.exitCode}\n${tail}`);
  }
  if (unsafe !== undefined) throw extractError(archivePath, `the archive is refused: ${unsafe}`);
}

const ENVIRONMENTAL = /No space left on device|Permission denied|Disk quota exceeded/i;

/**
 * Extracts a source archive so that `destination` becomes the source tree:
 * the archive's single `firefox-*` directory, or its root when it has none.
 * Every member is checked first, so nothing can be written outside the tree
 * and no `.git` can be planted in it. A failure that indicts the archive
 * removes it from the cache; one of the environment (a full disk, a missing
 * `tar`) keeps it for the retry.
 *
 * @param archivePath - The archive, in the host cache
 * @param destination - The directory to create; must not exist
 * @throws `extract-failed` (exit code 3)
 */
export async function extractArchive(archivePath: string, destination: string): Promise<void> {
  if ((await findExecutable('tar')) === undefined) {
    throw new FireForgeError('command-not-found', 'Extracting the Firefox source needs "tar"', {
      exitCode: ExitCode.MISSING_DEPENDENCY,
      hint: 'Install tar and make sure it is on PATH.',
    });
  }
  const staging = await makeTempDir(`${basename(destination)}.extract-`, dirname(destination));
  try {
    // Each listing decompresses the whole archive, so the two run side by side.
    await Promise.all([
      scanListing(archivePath, '-tf', unsafeArchiveMember),
      scanListing(archivePath, '-tvf', unsafeArchiveLink),
    ]).catch(async (error: unknown) => {
      await discardArchive(archivePath);
      throw error;
    });
    const extracted = await run('tar', ['-xf', archivePath, '-C', staging]);
    if (extracted.exitCode !== 0) {
      const tail = tailLines(extracted.stderr, 5).join('\n');
      if (ENVIRONMENTAL.test(extracted.stderr)) {
        throw extractError(
          archivePath,
          `tar could not write the source tree\n${tail}`,
          'Free disk space or fix the permissions, then retry; the downloaded archive is kept.'
        );
      }
      await discardArchive(archivePath);
      throw extractError(archivePath, `tar exited ${extracted.exitCode}\n${tail}`);
    }
    const top = (await listDir(staging)).filter(
      (entry) => entry.kind === 'directory' && entry.name.startsWith('firefox-')
    );
    await move(top.length === 1 ? join(staging, top[0]?.name ?? '') : staging, destination);
  } finally {
    await remove(staging);
  }
}
