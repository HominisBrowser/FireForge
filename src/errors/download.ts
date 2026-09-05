// SPDX-License-Identifier: EUPL-1.2
import type { FirefoxProduct } from '../types/config.js';
import { FireForgeError, remedies } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when Firefox source download fails.
 */
export class DownloadError extends FireForgeError {
  readonly code = ExitCode.DOWNLOAD_ERROR;

  constructor(
    message: string,
    public readonly url?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    return (
      `Download Error: ${this.message}` +
      (this.url ? `\n\nURL: ${this.url}` : '') +
      remedies([
        'Check your internet connection',
        'Verify the Firefox version in fireforge.json is valid',
        'Try again with "fireforge download --force"',
      ])
    );
  }
}

/**
 * Error thrown when a pinned Firefox source archive checksum does not match.
 */
export class ChecksumMismatchError extends DownloadError {
  constructor(
    public readonly product: FirefoxProduct,
    public readonly expectedSha256: string,
    public readonly actualSha256: string,
    url: string
  ) {
    super(
      `Downloaded archive SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
      url
    );
  }

  override get userMessage(): string {
    return (
      `Download Error: Firefox source archive checksum mismatch.\n\n` +
      `Product: ${this.product}\n` +
      `URL: ${this.url}\n` +
      `Expected SHA-256: ${this.expectedSha256}\n` +
      `Actual SHA-256: ${this.actualSha256}` +
      remedies([
        'Verify firefox.product, firefox.version, and firefox.sha256 in fireforge.json',
        'Compare the pinned hash with Mozilla SHA256SUMMARY for the resolved archive',
        ...(this.product === 'firefox-devedition'
          ? [
              'Developer Edition archives should resolve under https://archive.mozilla.org/pub/devedition/releases/',
            ]
          : []),
        'Re-run "fireforge download --force" after correcting the source settings',
      ])
    );
  }
}

/**
 * Error thrown when the default integrity check cannot obtain Mozilla's
 * published SHA-256 for a freshly downloaded archive (checksum file
 * unreachable, malformed, or not listing the archive) and no operator pin
 * or explicit opt-out allows the download to be trusted on TLS alone.
 */
export class ChecksumUnavailableError extends DownloadError {
  constructor(
    public readonly product: FirefoxProduct,
    public readonly checksumsUrl: string,
    public readonly reason: string,
    url: string
  ) {
    super(`Could not verify archive against published SHA256SUMS: ${reason}`, url);
  }

  override get userMessage(): string {
    return (
      `Download Error: Firefox source archive integrity could not be verified.\n\n` +
      `Product: ${this.product}\n` +
      `Archive: ${this.url ?? ''}\n` +
      `Checksums: ${this.checksumsUrl}\n` +
      `Reason: ${this.reason}\n\n` +
      'The archive was downloaded but discarded: without the published digest it would be ' +
      'trusted on TLS alone, and it becomes the git baseline every patch is built on.\n\n' +
      'To fix this:\n' +
      '  1. Check connectivity to archive.mozilla.org (a captive portal or proxy may be ' +
      'answering the SHA256SUMS request) and retry\n' +
      '  2. Or pin the archive digest: set firefox.sha256 in fireforge.json ' +
      '(from the release SHA256SUMS, obtained out of band)\n' +
      '  3. Or, for an offline mirror you trust, set firefox.allowUnverifiedDownload: true ' +
      'in fireforge.json to accept the download with a warning'
    );
  }
}

/**
 * Error thrown when extraction of the downloaded archive fails.
 */
export class ExtractionError extends DownloadError {
  constructor(
    public readonly archivePath: string,
    cause?: Error
  ) {
    super(`Failed to extract archive: ${archivePath}`, undefined, cause);
  }

  override get userMessage(): string {
    const reason = this.cause instanceof Error ? `Reason: ${this.cause.message}\n\n` : '';
    return (
      `Extraction Error: Failed to extract Firefox source archive.\n\n` +
      `Archive: ${this.archivePath}\n\n` +
      reason +
      'To fix this:\n' +
      '  1. Delete the corrupted archive and try again\n' +
      '  2. Ensure you have enough disk space\n' +
      '  3. Verify tar/xz tools are installed'
    );
  }
}

/**
 * Error thrown when the Firefox version is not found on the server.
 */
export class VersionNotFoundError extends DownloadError {
  constructor(public readonly version: string) {
    super(`Firefox version ${version} not found on archive.mozilla.org`);
  }

  override get userMessage(): string {
    return (
      `Download Error: Firefox version "${this.version}" was not found.\n\n` +
      'To fix this:\n' +
      '  1. Check the version number in fireforge.json\n' +
      '  2. Visit https://archive.mozilla.org/pub/firefox/releases/ to see available versions\n' +
      '  3. Update firefox.version in fireforge.json to a valid version'
    );
  }
}

/**
 * Error thrown when engine directory already exists.
 */
export class EngineExistsError extends DownloadError {
  constructor(public readonly enginePath: string) {
    super(`Engine directory already exists: ${enginePath}`);
  }

  override get userMessage(): string {
    return (
      `Download Error: Firefox source already exists.\n\n` +
      `Path: ${this.enginePath}\n\n` +
      'To fix this:\n' +
      '  1. Use "fireforge download --force" to re-download\n' +
      '  2. Or manually delete the engine/ directory'
    );
  }
}

/**
 * Error thrown when engine/ exists but contains an unborn git repo from a failed download.
 */
export class PartialEngineExistsError extends DownloadError {
  constructor(
    public readonly enginePath: string,
    cause?: Error
  ) {
    super(
      `Engine directory contains a partially initialized checkout: ${enginePath}`,
      undefined,
      cause
    );
  }

  override get userMessage(): string {
    const causeMessage =
      this.cause instanceof Error && this.cause.message ? this.cause.message : undefined;

    return (
      `Download Error: Firefox source exists, but the baseline git repository was not fully initialized.\n\n` +
      `Path: ${this.enginePath}\n\n` +
      (causeMessage ? `Underlying cause: ${causeMessage}\n\n` : '') +
      'To fix this:\n' +
      '  1. Re-run "fireforge download --force" to recreate the baseline repository\n' +
      '  2. Or manually delete the engine/ directory before downloading again\n' +
      '  3. Re-run with --verbose for the full underlying error and stack trace'
    );
  }
}
