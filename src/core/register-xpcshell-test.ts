// SPDX-License-Identifier: EUPL-1.2
/**
 * xpcshell test-file registration. Without it, xpcshell test files (e.g.
 * `<module-dir>/test/unit/test_*.js`) are rejected by `fireforge register`
 * as "Unknown file pattern". This writer inserts the `["test_*.js"]` section
 * into the directory's `xpcshell.toml` (alphabetically or after the
 * `--after` entry, idempotently). With
 * `--create-manifest` it also creates the manifest and wires
 * `XPCSHELL_TESTS_MANIFESTS` into the nearest moz.build.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { mozbuildSortCompare } from './moz-manifest-helpers.js';
import type { RegisterResult } from './register-result.js';
import { ensureXpcshellManifestWiring, type ScaffoldAction } from './register-scaffold.js';

function manifestMissingError(manifestRel: string): GeneralError {
  return new GeneralError(
    `Manifest not found: ${manifestRel}. ` +
      'Pass --create-manifest to scaffold the xpcshell.toml and wire XPCSHELL_TESTS_MANIFESTS ' +
      'into the nearest moz.build.'
  );
}

/**
 * Checks whether the test file is listed in its directory's
 * `xpcshell.toml`. Throws a "Manifest not found" error when the manifest
 * does not exist (status catches that prefix and reports the manifest as
 * missing rather than the file as unregistered).
 */
export async function isXpcshellTestRegistered(
  engineDir: string,
  dirRel: string,
  fileName: string
): Promise<boolean> {
  const manifestRel = `${dirRel}/xpcshell.toml`;
  const manifestPath = join(engineDir, manifestRel);
  if (!(await pathExists(manifestPath))) {
    throw manifestMissingError(manifestRel);
  }
  const content = await readText(manifestPath);
  return content.includes(`["${fileName}"]`);
}

/** Where a new section goes and what placed it there. */
export interface XpcshellSectionPlacement {
  /** The manifest content with the section inserted. */
  content: string;
  /** The `["…"]` header of the `--after` entry the section follows. */
  previousEntry?: string | undefined;
  /** `--after` named no entry, so the section went in sort order. */
  afterFallback?: boolean | undefined;
}

const SECTION_HEADER = /^\["([^"]+)"\]\s*$/;

/**
 * The line where the block headed at `headerIndex` starts: the header
 * itself, or the first of the `#` comment lines directly above it. A
 * comment describes the entry below it, so nothing is inserted between
 * them.
 */
function blockStart(lines: readonly string[], headerIndex: number): number {
  let start = headerIndex;
  while (start > 0 && (lines[start - 1] ?? '').trimStart().startsWith('#')) start -= 1;
  return start;
}

/** Index of the section header `after` names: exact name first, then a substring. */
function findAfterHeader(lines: readonly string[], after: string): number {
  const headers = lines
    .map((line, index) => ({ index, line, name: SECTION_HEADER.exec(line)?.[1] }))
    .filter((header) => header.name !== undefined);
  const exact = headers.find((header) => header.name === after || header.line.trim() === after);
  return (exact ?? headers.find((header) => header.line.includes(after)))?.index ?? -1;
}

function spliceSection(lines: string[], index: number, fileName: string): string {
  if (index === -1) {
    // Append after the last section (or at end of file when there are no
    // sections yet), keeping exactly one trailing newline.
    while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
    return [...lines, '', `["${fileName}"]`, ''].join('\n');
  }
  lines.splice(index, 0, `["${fileName}"]`, '');
  return lines.join('\n');
}

/**
 * Places the `["<fileName>"]` section in the manifest content.
 *
 * Without `after`, the section goes in mozbuild's case-insensitive sort
 * order relative to the other test sections. With `after`, it goes right
 * after the named entry's whole block (its keys included). Either way it
 * is inserted ahead of the `#` comment lines that introduce the next
 * entry, never between a comment and its entry, keeping one
 * blank line between sections.
 */
export function placeXpcshellManifestSection(
  content: string,
  fileName: string,
  after?: string
): XpcshellSectionPlacement {
  const lines = content.split('\n');
  const headerIndexes = lines.flatMap((line, index) => (SECTION_HEADER.test(line) ? [index] : []));

  if (after !== undefined) {
    const afterIndex = findAfterHeader(lines, after);
    if (afterIndex !== -1) {
      const next = headerIndexes.find((index) => index > afterIndex);
      return {
        content: spliceSection(lines, next === undefined ? -1 : blockStart(lines, next), fileName),
        previousEntry: (lines[afterIndex] ?? '').trim(),
      };
    }
  }

  const before = headerIndexes.find(
    (index) => mozbuildSortCompare(fileName, SECTION_HEADER.exec(lines[index] ?? '')?.[1] ?? '') < 0
  );
  return {
    content: spliceSection(lines, before === undefined ? -1 : blockStart(lines, before), fileName),
    ...(after !== undefined ? { afterFallback: true } : {}),
  };
}

/**
 * Inserts the `["<fileName>"]` section into the manifest content; see
 * {@link placeXpcshellManifestSection}. Exported for direct unit testing.
 *
 * @internal
 */
export function insertXpcshellManifestSection(
  content: string,
  fileName: string,
  after?: string
): string {
  return placeXpcshellManifestSection(content, fileName, after).content;
}

/**
 * Registers an xpcshell test file in its directory's `xpcshell.toml`.
 * With `createManifest`, a missing manifest is scaffolded and wired into
 * the nearest moz.build via `XPCSHELL_TESTS_MANIFESTS`.
 */
export async function registerXpcshellTest(
  engineDir: string,
  dirRel: string,
  fileName: string,
  dryRun = false,
  createManifest = false,
  after?: string
): Promise<RegisterResult> {
  const manifestRel = `${dirRel}/xpcshell.toml`;
  const manifestPath = join(engineDir, manifestRel);
  const entry = `["${fileName}"]`;

  if (!(await pathExists(manifestPath))) {
    if (!createManifest) {
      throw manifestMissingError(manifestRel);
    }
    const scaffoldActions: ScaffoldAction[] = [
      { manifest: manifestRel, change: `created with ${entry}` },
    ];
    if (!dryRun) {
      await writeText(manifestPath, `[DEFAULT]\n\n${entry}\n`);
    }
    scaffoldActions.push(...(await ensureXpcshellManifestWiring(engineDir, manifestRel, dryRun)));
    return { manifest: manifestRel, entry, skipped: false, scaffoldActions };
  }

  const content = await readText(manifestPath);
  if (content.includes(entry)) {
    return { manifest: manifestRel, entry, skipped: true };
  }

  const placement = placeXpcshellManifestSection(content, fileName, after);
  if (!dryRun) {
    await writeText(manifestPath, placement.content);
  }
  return {
    manifest: manifestRel,
    entry,
    skipped: false,
    previousEntry: placement.previousEntry,
    afterFallback: placement.afterFallback,
  };
}
