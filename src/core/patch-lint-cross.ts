// SPDX-License-Identifier: EUPL-1.2
/**
 * Cross-patch lint infrastructure: the queue context builder, the
 * duplicate-new-file-creation and forward-import rules, the
 * forward-import ignore-marker, and the per-specifier extractor that
 * powers the forward-import rule.
 *
 * Separated from `patch-lint.ts` so the per-patch and cross-patch rule
 * bodies stay within the project's per-file line budget. `patch-lint.ts`
 * re-exports the public surface so callers continue to import from a
 * single module.
 */

import { basename } from 'node:path';

import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { stripJsComments } from '../utils/regex.js';
import { discoverPatches } from './patch-files.js';
import { detectNewFilesInDiff, extractAddedLinesPerFile } from './patch-lint-diff.js';
import { loadPatchesManifest } from './patch-manifest-io.js';
import { extractNewFileContent } from './patch-transform.js';

/**
 * One patch's contribution to {@link PatchQueueContext}.
 *
 * Rules receive a flat view of every patch's metadata, raw diff, and the
 * content of any files the patch newly creates. Reading each patch once up
 * front lets rules operate in O(patches) without re-reading .patch files.
 */
export interface PatchQueueEntry {
  /** Filename on disk and in the manifest. */
  filename: string;
  /** Order number from the manifest (or filename prefix fallback). */
  order: number;
  /** Manifest metadata. Null when the patch file exists but has no entry. */
  metadata: PatchMetadata | null;
  /** Raw unified-diff content of the patch body. */
  diff: string;
  /**
   * Map from newly-created file path → the file content the patch would
   * produce. Populated only for files the patch creates with
   * `new file mode` + `--- /dev/null`. Modifications to existing files
   * are not indexed here.
   */
  newFiles: Map<string, string>;
  /**
   * Map from existing-file path → concatenated added lines from the patch's
   * hunks against that file (joined with `\n`). Populated for files the
   * patch *modifies* (i.e. paths that show up in the diff without a
   * `new file mode` marker). The forward-import rule and `patch delete`
   * dependency scan use this to detect imports added into pre-existing
   * files — a failure mode the newFiles map cannot represent because it
   * only tracks creations.
   */
  modifiedFileAdditions: Map<string, string>;
}

/**
 * Queue-wide context passed to cross-patch lint rules.
 *
 * "Projected" means rules receive a potentially hypothetical view of the
 * queue — the caller may have already applied a planned delete, reorder, or
 * re-export to the entries before calling the rule. This lets
 * `patch reorder`, `patch delete`, `export --order`, and `re-export --files`
 * run the same cross-patch checks they would hit on a real run, without
 * mutating disk first.
 */
export interface PatchQueueContext {
  /** Entries in application order (lowest `order` first). */
  entries: PatchQueueEntry[];
}

/**
 * Builds a {@link PatchQueueContext} by reading every .patch file in the
 * directory and extracting new-file content for each creation.
 *
 * Reads manifest metadata best-effort: if the manifest is missing or a patch
 * file has no metadata entry, the context still populates the entry from the
 * filename prefix so cross-patch rules can operate on a drift state. (A
 * separate consistency check — see `patches verify` — is responsible for
 * reporting the drift as its own error.)
 *
 * @param patchesDir - Path to the patches directory
 */
export async function buildPatchQueueContext(patchesDir: string): Promise<PatchQueueContext> {
  const patches = await discoverPatches(patchesDir);
  const manifest = await loadPatchesManifest(patchesDir);
  const metadataByFilename = new Map<string, PatchMetadata>();
  if (manifest) {
    for (const entry of manifest.patches) {
      metadataByFilename.set(entry.filename, entry);
    }
  }

  const entries: PatchQueueEntry[] = [];
  for (const patch of patches) {
    const diff = await readText(patch.path);
    const newFilePaths = detectNewFilesInDiff(diff);
    const newFiles = new Map<string, string>();
    for (const newFile of newFilePaths) {
      try {
        const content = await extractNewFileContent(patch.path, newFile);
        newFiles.set(newFile, content);
      } catch (error: unknown) {
        verbose(
          `Skipping forward-import scan for ${newFile} in ${patch.filename}: ${toError(error).message}`
        );
      }
    }

    // Added-line content for every file the patch modifies but does not
    // create. Fed to the forward-import rule so imports introduced into
    // pre-existing files are checked too, not only imports in brand-new
    // files. We deliberately skip paths in newFilePaths — those are
    // already covered by the newFiles map, which carries full content
    // rather than only the added lines.
    const addedLinesByFile = extractAddedLinesPerFile(diff);
    const modifiedFileAdditions = new Map<string, string>();
    for (const [file, lines] of addedLinesByFile) {
      if (newFilePaths.has(file)) continue;
      modifiedFileAdditions.set(file, lines.join('\n'));
    }

    entries.push({
      filename: patch.filename,
      order: Number.isFinite(patch.order) ? patch.order : entries.length + 1,
      metadata: metadataByFilename.get(patch.filename) ?? null,
      diff,
      newFiles,
      modifiedFileAdditions,
    });
  }

  // Sort by order so rules can rely on entries being in apply order.
  entries.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));

  return { entries };
}

/**
 * Returns the raw `path → patches[]` map of files created in `new file
 * mode` by at least one patch in the queue. Paths created by only one
 * patch are also included so callers can distinguish "no creator" from
 * "exactly one creator" without re-scanning the diffs.
 *
 * Split out from {@link lintPatchQueueDuplicateCreations} so
 * `status --ownership` (and any future caller that wants ownership
 * without a rendered PatchLintIssue) can consume the same structured
 * data the rule itself relies on. Previously status had to parse the
 * rule's human-readable message to recover the patch list, which was
 * both fragile and made the lint message format part of an implicit
 * contract.
 *
 * @param ctx - Pre-built queue context
 */
export function collectNewFileCreatorsByPath(ctx: PatchQueueContext): Map<string, string[]> {
  const creators = new Map<string, string[]>();
  for (const entry of ctx.entries) {
    const newFiles = detectNewFilesInDiff(entry.diff);
    for (const file of newFiles) {
      let owners = creators.get(file);
      if (!owners) {
        owners = [];
        creators.set(file, owners);
      }
      owners.push(entry.filename);
    }
  }
  return creators;
}

/**
 * Cross-patch lint rule: the same path is newly created (`--- /dev/null →
 * +++ b/path`) by more than one patch. This is the failure mode that
 * motivated the rule — Hominis landed three patches each trying to create
 * the same file, and the error surfaced only when import rolled back
 * mid-apply.
 *
 * Reports one error per conflicting path, naming every patch that creates
 * the path so the operator can pick the correct fix (`patch delete` or
 * `re-export --files`).
 */
export function lintPatchQueueDuplicateCreations(ctx: PatchQueueContext): PatchLintIssue[] {
  const creators = collectNewFileCreatorsByPath(ctx);
  const issues: PatchLintIssue[] = [];
  for (const [file, owners] of creators) {
    if (owners.length > 1) {
      issues.push({
        file,
        check: 'duplicate-new-file-creation',
        fingerprint: `duplicate-new-file-creation|${file}|${[...owners].sort((a, b) => a.localeCompare(b)).join(',')}`,
        message:
          `File "${file}" is created (new file mode) by multiple patches: ${owners.join(', ')}. ` +
          'Only one patch may create a given path. Use "patch delete" or ' +
          '"re-export --files" to remove the duplicate.',
        severity: 'error',
      });
    }
  }
  return issues;
}

const FORWARD_IMPORTABLE_EXTENSIONS = ['.mjs', '.sys.mjs', '.js', '.jsm'];

/**
 * Returns true when a path looks like a JS module/subscript the
 * forward-import rule should scan.
 */
export function isForwardImportableFile(path: string): boolean {
  return FORWARD_IMPORTABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Regex-level extractor for module specifiers in ES module / subscript files.
 *
 * Intentionally conservative. Catches:
 * - `import ... from "specifier"`   (ES module static imports)
 * - `import "specifier"`            (side-effect imports — the `from`
 *                                   clause is optional in the regex)
 * - `import("specifier")`           (dynamic imports)
 * - ChromeUtils.importESModule("specifier")
 * - ChromeUtils.defineESModuleGetters(obj, { Name: "specifier", ... })
 *
 * Returns the raw specifier strings — callers should take the leaf basename
 * to match against the newFileIndex, because we do not resolve `resource://`
 * URLs to engine file paths.
 */
export function extractImportSpecifiers(source: string): string[] {
  return extractImportSpecifiersWithLines(source).map((item) => item.specifier);
}

/**
 * Internal form of {@link extractImportSpecifiers} that also returns the
 * (0-indexed) line number where each specifier was found. Used by the
 * forward-import rule so it can correlate specifiers against the
 * ignore-marker line set and skip suppressed matches.
 */
export interface ExtractedSpecifier {
  specifier: string;
  line: number;
}

function buildLineOffsets(source: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function makeOffsetToLine(lineOffsets: readonly number[]): (offset: number) => number {
  return (offset: number): number => {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const candidate = lineOffsets[mid];
      if (candidate === undefined || candidate > offset) {
        hi = mid - 1;
      } else {
        lo = mid;
      }
    }
    return lo;
  };
}

/**
 * Walks `defineESModuleGetters(obj, { ... })` calls using a balanced
 * brace walker so nested object literals and multi-line shapes do not
 * terminate the parse early. Appends the string literals found inside
 * the getter map to `results`.
 */
function collectGetterSpecifiers(
  stripped: string,
  results: ExtractedSpecifier[],
  offsetToLine: (offset: number) => number
): void {
  const gettersOpenPattern = /defineESModuleGetters\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = gettersOpenPattern.exec(stripped)) !== null) {
    const openParen = stripped.indexOf('(', match.index);
    if (openParen === -1) continue;

    // Walk to the first top-level `{` inside the call — the start of
    // the getter-map object literal. Bail if we reach the closing `)`
    // first (no object literal argument given).
    let depthParen = 1;
    let openBrace = -1;
    for (let i = openParen + 1; i < stripped.length; i++) {
      const char = stripped[i];
      if (char === '(') depthParen += 1;
      else if (char === ')') {
        depthParen -= 1;
        if (depthParen === 0) break;
      } else if (char === '{' && depthParen === 1) {
        openBrace = i;
        break;
      }
    }
    if (openBrace === -1) continue;

    // Walk the object-literal body with balanced braces so nested
    // `{ ... }` inside a value does not terminate the walk early.
    let depthBrace = 1;
    let closeBrace = -1;
    for (let i = openBrace + 1; i < stripped.length; i++) {
      const char = stripped[i];
      if (char === '{') depthBrace += 1;
      else if (char === '}') {
        depthBrace -= 1;
        if (depthBrace === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    if (closeBrace === -1) continue;

    const body = stripped.slice(openBrace + 1, closeBrace);
    const bodyStart = openBrace + 1;
    const stringLiteralPattern = /["']([^"']+)["']/g;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = stringLiteralPattern.exec(body)) !== null) {
      if (strMatch[1]) {
        results.push({
          specifier: strMatch[1],
          line: offsetToLine(bodyStart + strMatch.index),
        });
      }
    }
  }
}

/**
 * Returns import specifiers plus 0-indexed line numbers, preserving the
 * same matching behavior as {@link extractImportSpecifiers}.
 */
export function extractImportSpecifiersWithLines(source: string): ExtractedSpecifier[] {
  // stripJsComments replaces comment bodies with space runs of equal
  // length, preserving character offsets. That lets us match against
  // the stripped source (so we do not match `import` tokens inside
  // block comments or string literals) while still reporting line
  // numbers based on the ORIGINAL source, which is what the
  // ignore-marker scan walks.
  const stripped = stripJsComments(source);
  const results: ExtractedSpecifier[] = [];
  const lineOffsets = buildLineOffsets(source);
  const offsetToLine = makeOffsetToLine(lineOffsets);

  const importFromPattern = /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importFromPattern.exec(stripped)) !== null) {
    if (match[1]) results.push({ specifier: match[1], line: offsetToLine(match.index) });
  }

  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamicImportPattern.exec(stripped)) !== null) {
    if (match[1]) results.push({ specifier: match[1], line: offsetToLine(match.index) });
  }

  // ChromeUtils.importESModule("resource://...") — Firefox single-module import
  const chromeUtilsPattern = /ChromeUtils\.importESModule\s*\(\s*["']([^"']+)["']/g;
  while ((match = chromeUtilsPattern.exec(stripped)) !== null) {
    if (match[1]) results.push({ specifier: match[1], line: offsetToLine(match.index) });
  }

  collectGetterSpecifiers(stripped, results, offsetToLine);

  return results;
}

/**
 * Marker comment operators can use to suppress the forward-import rule
 * for imports that resolve to a basename false positive (two unrelated
 * files with the same leaf name) or for any other situation where the
 * regex-level resolution lands on the wrong patch.
 *
 * Usage: place the comment on the same line as the import, or on the
 * line immediately above it:
 *
 * ```js
 * // fireforge-ignore: forward-import
 * import { Helper } from "resource:///modules/Helper.sys.mjs";
 *
 * import { Helper } from "resource:///modules/Helper.sys.mjs"; // fireforge-ignore: forward-import
 * ```
 */
export const FORWARD_IMPORT_IGNORE_MARKER = 'fireforge-ignore: forward-import';

/**
 * Returns a Set of 0-indexed line numbers on which the forward-import
 * rule should be suppressed. A marker on line N suppresses matches on
 * line N and N+1 so users can write the marker above the line it
 * describes. Matches on any line past N+1 are not affected.
 */
export function findForwardImportIgnoreLines(source: string): Set<number> {
  const lines = source.split('\n');
  const ignored = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.includes(FORWARD_IMPORT_IGNORE_MARKER)) {
      ignored.add(i);
      ignored.add(i + 1);
    }
  }
  return ignored;
}

/**
 * Cross-patch lint rule: a patch imports a module that a later patch is
 * responsible for creating.
 *
 * Approach is deliberately conservative — we do not resolve `resource://`
 * URLs to engine file paths. Instead we build a cross-queue index of
 * newly-created files keyed by their basename, and flag imports whose leaf
 * matches an entry owned by a later-ordered patch. False positives from
 * unrelated basename collisions (two different directories happening to
 * create files named `Helper.sys.mjs`) are possible; the README documents
 * the limitation and the inline ignore marker above provides an escape
 * hatch.
 *
 * Rules out:
 * - Imports whose leaf matches a newly-created file in the *same* or an
 *   *earlier* patch (legitimate use).
 * - Imports whose leaf is not in the new-file index at all (pre-existing
 *   engine file — not our concern).
 * - Imports on a line suppressed by the ignore marker.
 */
export function lintPatchQueueForwardImports(ctx: PatchQueueContext): PatchLintIssue[] {
  interface NewFileOwner {
    filename: string;
    order: number;
    fullPath: string;
  }

  const newFileIndex = new Map<string, NewFileOwner[]>();
  for (const entry of ctx.entries) {
    for (const fullPath of entry.newFiles.keys()) {
      const leaf = basename(fullPath);
      let owners = newFileIndex.get(leaf);
      if (!owners) {
        owners = [];
        newFileIndex.set(leaf, owners);
      }
      owners.push({ filename: entry.filename, order: entry.order, fullPath });
    }
  }

  const issues: PatchLintIssue[] = [];

  // Runs the forward-import check against one source site — either a file
  // the patch creates (`content` = full file) or a file the patch modifies
  // (`content` = concatenated added lines only). We deliberately scan added
  // lines rather than the full resulting file for modifications: we only
  // want to flag imports *this patch introduces*, not imports that already
  // exist on HEAD and happen to match a later-created file by coincidence.
  const checkSite = (entry: PatchQueueEntry, sitePath: string, content: string): void => {
    if (!isForwardImportableFile(sitePath)) return;

    const ignoreLines = findForwardImportIgnoreLines(content);
    const extracted = extractImportSpecifiersWithLines(content);
    for (const { specifier, line } of extracted) {
      if (ignoreLines.has(line)) continue;
      // Take the leaf and strip query/hash if any.
      const cleaned = specifier.split(/[?#]/)[0] ?? specifier;
      const leaf = basename(cleaned);
      if (!leaf || !isForwardImportableFile(leaf)) continue;

      const owners = newFileIndex.get(leaf);
      if (!owners) continue;

      // Is the owner a later-ordered patch (or one ordered equal but
      // lexicographically later as a tiebreaker)?
      const laterOwners = owners.filter(
        (owner) =>
          owner.order > entry.order ||
          (owner.order === entry.order && owner.filename > entry.filename)
      );
      if (laterOwners.length === 0) continue;

      const ownersSummary = laterOwners
        .map((o) => `${o.filename} (creates ${o.fullPath})`)
        .join(', ');
      const fingerprintOwners = [...laterOwners]
        .map((o) => `${o.filename}:${o.fullPath}`)
        .sort((a, b) => a.localeCompare(b))
        .join(',');

      issues.push({
        file: sitePath,
        check: 'forward-import',
        fingerprint: `forward-import|${sitePath}|${cleaned}|${fingerprintOwners}`,
        message:
          `${sitePath} in ${entry.filename} imports "${specifier}", ` +
          `but the matching new file is created by a later patch: ${ownersSummary}. ` +
          'Reorder the patches so the dependency is created first, move the import ' +
          'into the later patch, or mark the import with ' +
          `"// ${FORWARD_IMPORT_IGNORE_MARKER}" if the basename collision is a false positive.`,
        severity: 'error',
      });
    }
  };

  for (const entry of ctx.entries) {
    for (const [path, content] of entry.newFiles) checkSite(entry, path, content);
    for (const [path, added] of entry.modifiedFileAdditions) checkSite(entry, path, added);
  }

  return issues;
}

/**
 * Cross-patch lint orchestrator. Runs every cross-patch rule against the
 * provided context and returns combined issues.
 *
 * Separate from `lintExportedPatch` because cross-patch rules operate
 * over the whole queue, not a single patch. Callers integrating both
 * orchestrators (e.g. `fireforge lint`) should concatenate results.
 *
 * @param ctx - Pre-built queue context (use
 *   {@link buildPatchQueueContext} for the default path, or construct
 *   manually for projected/hypothetical states)
 */
export function lintPatchQueue(ctx: PatchQueueContext): PatchLintIssue[] {
  return [...lintPatchQueueDuplicateCreations(ctx), ...lintPatchQueueForwardImports(ctx)];
}
