// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
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
    let msg = `Download Error: ${this.message}`;

    if (this.url) {
      msg += `\n\nURL: ${this.url}`;
    }

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check your internet connection\n';
    msg += '  2. Verify the Firefox version in fireforge.json is valid\n';
    msg += '  3. Try again with "fireforge download --force"';

    return msg;
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
    return (
      `Extraction Error: Failed to extract Firefox source archive.\n\n` +
      `Archive: ${this.archivePath}\n\n` +
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
  constructor(public readonly enginePath: string) {
    super(`Engine directory contains a partially initialized checkout: ${enginePath}`);
  }

  override get userMessage(): string {
    return (
      `Download Error: Firefox source exists, but the baseline git repository was not fully initialized.\n\n` +
      `Path: ${this.enginePath}\n\n` +
      'To fix this:\n' +
      '  1. Re-run "fireforge download --force" to recreate the baseline repository\n' +
      '  2. Or manually delete the engine/ directory before downloading again'
    );
  }
}
