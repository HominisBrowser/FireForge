// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when `patches.json` exists but cannot be parsed or validated.
 *
 * This must be a HARD error on every mutating path. The historical behavior
 * collapsed "corrupt" into "absent" (`loadPatchesManifest` returned null for
 * both), so the next `fireforge export` would rebuild the manifest containing
 * only the new patch — silently destroying every other patch's metadata
 * (tiers, descriptions, lintIgnore, staged dependencies) — and a failed
 * export's rollback would then delete `patches.json` outright because the
 * "before" state looked absent (2026-07-05 review, finding H2).
 */
export class PatchManifestCorruptError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  constructor(
    public readonly manifestPath: string,
    cause?: Error
  ) {
    super(
      `patches.json exists but could not be parsed: ${cause?.message ?? 'unknown parse error'}`,
      cause
    );
  }

  override get userMessage(): string {
    return (
      `Patch Manifest Error: ${this.message}\n\n` +
      `Manifest: ${this.manifestPath}\n\n` +
      'FireForge refuses to modify the patch queue while patches.json is unreadable — ' +
      'rewriting it now would silently discard the metadata of every patch it lists.\n\n' +
      'To fix this:\n' +
      '  1. Open patches.json and repair the syntax error (a recent hand-edit is the usual cause)\n' +
      '  2. Or restore patches.json from version control\n' +
      '  3. Then re-run the command'
    );
  }
}

/**
 * Error thrown when patch operations fail.
 */
export class PatchError extends FireForgeError {
  readonly code = ExitCode.PATCH_ERROR;

  constructor(
    message: string,
    public readonly patchName?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    let msg = `Patch Error: ${this.message}`;

    if (this.patchName) {
      msg += `\n\nPatch: ${this.patchName}`;
    }

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check if the patch is compatible with the Firefox version\n';
    msg += '  2. Use "fireforge reset" to start with clean source\n';
    msg += '  3. Update the patch for the current Firefox version';

    return msg;
  }
}
