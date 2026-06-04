// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { createSiblingLockPath, withFileLock } from '../core/file-lock.js';
import { resolvePatchIdentifier } from '../core/patch-manifest.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

interface ScanFilesManifestAssignment {
  patch: string;
  files: string[];
}

interface ScanFilesManifest {
  assignments: ScanFilesManifestAssignment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScanFilesManifest(raw: string, manifestPath: string): ScanFilesManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new InvalidArgumentError(
      `--scan-files manifest is not valid JSON (${manifestPath}): ${toError(error).message}`,
      '--scan-files'
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['assignments'])) {
    throw new InvalidArgumentError(
      '--scan-files manifest must contain an assignments array.',
      '--scan-files'
    );
  }

  const assignments: ScanFilesManifestAssignment[] = [];
  for (const [index, assignment] of parsed['assignments'].entries()) {
    if (!isRecord(assignment)) {
      throw new InvalidArgumentError(
        `--scan-files assignments[${index}] must be an object.`,
        '--scan-files'
      );
    }
    const { patch, files } = assignment;
    if (typeof patch !== 'string' || patch.trim().length === 0) {
      throw new InvalidArgumentError(
        `--scan-files assignments[${index}].patch must be a non-empty string.`,
        '--scan-files'
      );
    }
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every((file) => typeof file === 'string')
    ) {
      throw new InvalidArgumentError(
        `--scan-files assignments[${index}].files must be a non-empty string array.`,
        '--scan-files'
      );
    }
    assignments.push({ patch, files });
  }

  if (assignments.length === 0) {
    throw new InvalidArgumentError(
      '--scan-files manifest must assign at least one file.',
      '--scan-files'
    );
  }

  return { assignments };
}

/** Loads and validates a `re-export --scan-files` assignment manifest. */
export async function loadScanFilesAssignments(
  manifestPath: string,
  manifest: PatchesManifest
): Promise<Map<string, string[]>> {
  const parsed = parseScanFilesManifest(await readText(manifestPath), manifestPath);
  const filesByPatch = new Map<string, Set<string>>();
  const ownerByFile = new Map<string, string>();

  for (const assignment of parsed.assignments) {
    const patch = resolvePatchIdentifier(assignment.patch, manifest.patches);
    if (!patch) {
      const available = manifest.patches.map((entry) => entry.filename).join(', ');
      throw new InvalidArgumentError(
        `--scan-files patch "${assignment.patch}" not found in manifest.\n\nAvailable patches: ${available}`,
        '--scan-files'
      );
    }

    const patchFiles = filesByPatch.get(patch.filename) ?? new Set<string>();
    filesByPatch.set(patch.filename, patchFiles);
    for (const rawFile of assignment.files) {
      const file = normalizeEngineRelativeInput(rawFile, '--scan-files');
      const previousOwner = ownerByFile.get(file);
      if (previousOwner !== undefined && previousOwner !== patch.filename) {
        throw new InvalidArgumentError(
          `--scan-files path is assigned to more than one patch: ${file} (${previousOwner}, ${patch.filename})`,
          '--scan-files'
        );
      }
      ownerByFile.set(file, patch.filename);
      patchFiles.add(file);
    }
  }

  return new Map(
    [...filesByPatch.entries()].map(([patchFilename, files]) => [patchFilename, [...files].sort()])
  );
}

/** Serializes dry-run re-export git inspection against the same project tree. */
export async function withDryRunReExportLock<T>(
  fireforgeDir: string,
  isDryRun: boolean,
  operation: () => Promise<T>
): Promise<T> {
  if (!isDryRun) return operation();
  const lockPath = createSiblingLockPath(join(fireforgeDir, 're-export-dry-run'), '.lock');
  return withFileLock(lockPath, operation, {
    timeoutMs: 24 * 60 * 60 * 1000,
    onTimeoutMessage:
      `Timed out waiting for the FireForge re-export dry-run lock at ${lockPath}. ` +
      'If no other `fireforge re-export --dry-run` is running, remove the lock directory and retry.',
    onStaleLockMessage: (ageMs) =>
      `Removing stale FireForge re-export dry-run lock (age: ${Math.round(ageMs / 1000)}s). A previous dry-run process may have crashed.`,
  });
}
