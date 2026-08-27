// SPDX-License-Identifier: EUPL-1.2
/**
 * Foreign-drift preview + `--refuse-foreign-drift` gate for `re-export`.
 *
 * A scan-less re-export rebuilds each patch body as a whole-file
 * `git diff HEAD` over the owned files — so a CONCURRENT session's
 * uncommitted lines inside a file the patch already owns are silently
 * absorbed into the refreshed body. The adjacency advisory
 * (`re-export-adjacent.ts`) warns about unmanaged NEIGHBOUR files but is
 * structurally blind to drift inside owned files. This module compares
 * the old body against the refreshed body per file and reports the
 * payload lines that are about to ENTER the body; under
 * `--refuse-foreign-drift` the patch is skipped and the run exits
 * non-zero, mirroring `--refuse-adjacent-unmanaged`.
 *
 * "Foreign" is decided by content, not authorship: re-export's legitimate
 * job is capturing intentional engine edits, so the preview always prints
 * and the hard stop is an explicit opt-in for multi-session checkouts.
 * The comparison is offset-insensitive — per-file MULTISETS of `+`/`-`
 * payload lines — because a refresh legitimately shifts hunk offsets and
 * context without changing what the patch does.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiffSection } from '../core/patch-parse.js';
import { parseDiffSections } from '../core/patch-parse.js';
import type { PatchMetadata } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { info, verbose, warn } from '../utils/logger.js';

/** Why a patch was refused under `--refuse-foreign-drift`. */
export type ForeignDriftRefusalReason = 'foreign-drift' | 'baseline-unreadable';

/** Per-run context threaded through the re-export loop (mirrors). */
export interface ForeignDriftContext {
  refuseForeignDrift: boolean;
  /**
   * Engine-relative files whose drift is expected (`--expect`):
   * drift confined to these files does not refuse. Files here that never
   * drift are reported after the run as likely typos.
   */
  expectedDriftFiles: ReadonlySet<string>;
  /** Expected files that actually drifted at least once this run. */
  expectedSeen: Set<string>;
  /** Number of patches whose old/new bodies reached the drift comparison. */
  evaluationRuns: number;
  refusals: { patchFilename: string; files: string[]; reason: ForeignDriftRefusalReason }[];
}

/** One owned file's foreign drift between the old and refreshed body. */
export interface FileForeignDrift {
  file: string;
  /** `+` payload lines in the new body not present in the old body. */
  addedLines: number;
  /** `-` payload lines in the new body not present in the old body. */
  removedLines: number;
  /** `@@` headers of new-body hunks carrying foreign lines (capped). */
  hunkSummaries: string[];
  /** True when a binary section's recorded new-side blob hash changed. */
  binaryChanged: boolean;
}

const MAX_HUNK_SUMMARIES_PER_FILE = 3;
const MAX_FILES_REPORTED = 10;

interface FilePayload {
  added: Map<string, number>;
  removed: Map<string, number>;
  binaryNewHash: string | undefined;
  isBinary: boolean;
  sections: DiffSection[];
}

function collectPayloadByFile(body: string): Map<string, FilePayload> {
  const byFile = new Map<string, FilePayload>();
  for (const section of parseDiffSections(body)) {
    const file = section.targetPath;
    let payload = byFile.get(file);
    if (!payload) {
      payload = {
        added: new Map(),
        removed: new Map(),
        binaryNewHash: undefined,
        isBinary: false,
        sections: [],
      };
      byFile.set(file, payload);
    }
    payload.sections.push(section);
    if (section.isBinary) {
      payload.isBinary = true;
      payload.binaryNewHash = section.indexNewHash;
      continue;
    }
    for (const hunk of section.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          const text = line.slice(1);
          payload.added.set(text, (payload.added.get(text) ?? 0) + 1);
        } else if (line.startsWith('-')) {
          const text = line.slice(1);
          payload.removed.set(text, (payload.removed.get(text) ?? 0) + 1);
        }
      }
    }
  }
  return byFile;
}

/** Multiset difference: occurrences of `next` not consumed by `previous`. */
function multisetExcess(
  next: ReadonlyMap<string, number>,
  previous: ReadonlyMap<string, number>
): Map<string, number> {
  const excess = new Map<string, number>();
  for (const [text, count] of next) {
    const remaining = count - (previous.get(text) ?? 0);
    if (remaining > 0) excess.set(text, remaining);
  }
  return excess;
}

function summarizeForeignHunks(
  payload: FilePayload,
  foreignAdded: ReadonlyMap<string, number>,
  foreignRemoved: ReadonlyMap<string, number>
): string[] {
  const summaries: string[] = [];
  const addedBudget = new Map(foreignAdded);
  const removedBudget = new Map(foreignRemoved);
  for (const section of payload.sections) {
    for (const hunk of section.hunks) {
      let added = 0;
      let removed = 0;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          const text = line.slice(1);
          const budget = addedBudget.get(text) ?? 0;
          if (budget > 0) {
            addedBudget.set(text, budget - 1);
            added++;
          }
        } else if (line.startsWith('-')) {
          const text = line.slice(1);
          const budget = removedBudget.get(text) ?? 0;
          if (budget > 0) {
            removedBudget.set(text, budget - 1);
            removed++;
          }
        }
      }
      if (added > 0 || removed > 0) {
        summaries.push(
          `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@ (+${String(added)}/-${String(removed)})`
        );
      }
    }
  }
  return summaries;
}

function countExcess(excess: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of excess.values()) total += count;
  return total;
}

/**
 * Pure comparison: per owned file, which `+`/`-` payload lines the
 * refreshed body carries that the old body did not. Files NOT in
 * `previousFilesAffected` are skipped — those are intentional adoptions
 * (`--scan`), not drift.
 */
export function computeForeignDrift(
  oldBody: string,
  newBody: string,
  previousFilesAffected: readonly string[]
): FileForeignDrift[] {
  const owned = new Set(previousFilesAffected);
  const oldByFile = collectPayloadByFile(oldBody);
  const newByFile = collectPayloadByFile(newBody);
  const drift: FileForeignDrift[] = [];

  for (const [file, next] of newByFile) {
    if (!owned.has(file)) continue;
    const previous = oldByFile.get(file);
    if (next.isBinary || previous?.isBinary === true) {
      const binaryChanged =
        next.binaryNewHash === undefined ||
        previous?.binaryNewHash === undefined ||
        !(
          next.binaryNewHash.startsWith(previous.binaryNewHash) ||
          previous.binaryNewHash.startsWith(next.binaryNewHash)
        );
      if (binaryChanged) {
        drift.push({ file, addedLines: 0, removedLines: 0, hunkSummaries: [], binaryChanged });
      }
      continue;
    }
    const foreignAdded = multisetExcess(next.added, previous?.added ?? new Map());
    const foreignRemoved = multisetExcess(next.removed, previous?.removed ?? new Map());
    const addedLines = countExcess(foreignAdded);
    const removedLines = countExcess(foreignRemoved);
    if (addedLines === 0 && removedLines === 0) continue;
    drift.push({
      file,
      addedLines,
      removedLines,
      hunkSummaries: summarizeForeignHunks(next, foreignAdded, foreignRemoved).slice(
        0,
        MAX_HUNK_SUMMARIES_PER_FILE
      ),
      binaryChanged: false,
    });
  }

  return drift;
}

/**
 * Reads the old body, prints the always-on drift preview (including under
 * dry-run and `--scan`), and — when `ctx.refuseForeignDrift` is set —
 * records a refusal and returns `true` so the caller skips the write.
 */
export async function reportForeignDrift(args: {
  patch: PatchMetadata;
  patchesDir: string;
  engineDir: string;
  newDiffContent: string;
  ctx: ForeignDriftContext;
}): Promise<boolean> {
  const { patch, patchesDir, engineDir, newDiffContent, ctx } = args;
  const oldPath = join(patchesDir, patch.filename);
  let oldBody: string;
  try {
    if (!(await pathExists(oldPath))) {
      return refuseUnreadableBaseline(ctx, patch.filename, 'old patch body missing');
    }
    oldBody = await readText(oldPath);
  } catch (error: unknown) {
    return refuseUnreadableBaseline(
      ctx,
      patch.filename,
      `old body unreadable (${toError(error).message})`
    );
  }

  const drift = computeForeignDrift(oldBody, newDiffContent, patch.filesAffected);
  ctx.evaluationRuns += 1;
  if (drift.length === 0) return false;

  const unexpected = drift.filter((d) => !ctx.expectedDriftFiles.has(d.file));
  for (const entry of drift) {
    if (ctx.expectedDriftFiles.has(entry.file)) ctx.expectedSeen.add(entry.file);
  }

  const recentlyEdited = await findFilesEditedSinceLastExport(
    engineDir,
    oldPath,
    drift.map((d) => d.file)
  );

  const totalLines = drift.reduce((sum, d) => sum + d.addedLines + d.removedLines, 0);
  const lineNoun = totalLines === 1 ? 'line' : 'lines';
  warn(
    `${patch.filename}: refreshed body absorbs ${String(totalLines)} ${lineNoun} not present in the old patch body (${String(drift.length)} file(s)):`
  );
  for (const entry of drift.slice(0, MAX_FILES_REPORTED)) {
    const expectedTag = ctx.expectedDriftFiles.has(entry.file) ? ' (expected via --expect)' : '';
    const authorshipTag = recentlyEdited.has(entry.file)
      ? ' [edited since your last export]'
      : ' [unchanged since your last export — another session may own it]';
    if (entry.binaryChanged) {
      info(`  ${entry.file}: binary content changed${expectedTag}${authorshipTag}`);
      continue;
    }
    info(
      `  ${entry.file}: +${String(entry.addedLines)}/-${String(entry.removedLines)} newly captured line(s)${expectedTag}${authorshipTag}`
    );
    for (const summary of entry.hunkSummaries) {
      info(`    ${summary}`);
    }
  }
  if (drift.length > MAX_FILES_REPORTED) {
    info(`  +${String(drift.length - MAX_FILES_REPORTED)} more file(s)`);
  }

  if (ctx.refuseForeignDrift) {
    if (unexpected.length === 0) {
      info(
        `${patch.filename}: drift confined to --expect file(s); proceeding under --refuse-foreign-drift.`
      );
      return false;
    }
    ctx.refusals.push({
      patchFilename: patch.filename,
      files: unexpected.map((d) => d.file),
      reason: 'foreign-drift',
    });
    warn(`${patch.filename}: skipped (--refuse-foreign-drift).`);
    return true;
  }

  warn(
    '  If these are intentional engine edits, this is the normal re-export flow. ' +
      "FireForge cannot PROVE authorship; the per-file tags above compare each file's " +
      'modification time against this patch\'s last export, so "edited since your last ' +
      'export" marks lines you most likely wrote yourself. If another session owns them, ' +
      "re-run with --refuse-foreign-drift, or commit/stash that session's edits first."
  );
  return false;
}

/**
 * Splits the drifting files into "you probably wrote this" and "this predates
 * your last export". `--refuse-foreign-drift` calls every absorbed line
 * "foreign" — including the operator's OWN additions from the same session —
 * and "foreign" reads as "another session's", which is precisely the case
 * where proceeding would be wrong. Authorship is unknowable, but RECENCY is
 * not: a file whose mtime is newer than the patch body this run is refreshing
 * changed after the last export, which on a single-operator slice is the
 * operator's own edit. Returns the subset of `files` that qualifies; an
 * unstattable path is reported as NOT recently edited, so the cautious
 * wording is the fallback.
 */
async function findFilesEditedSinceLastExport(
  engineDir: string,
  patchBodyPath: string,
  files: readonly string[]
): Promise<Set<string>> {
  const recent = new Set<string>();
  let patchMtimeMs: number;
  try {
    patchMtimeMs = (await stat(patchBodyPath)).mtimeMs;
  } catch (error: unknown) {
    verbose(`Could not stat ${patchBodyPath} for drift recency: ${toError(error).message}`);
    return recent;
  }
  for (const file of files) {
    try {
      if ((await stat(join(engineDir, file))).mtimeMs > patchMtimeMs) recent.add(file);
    } catch (error: unknown) {
      verbose(`Could not stat ${file} for drift recency: ${toError(error).message}`);
    }
  }
  return recent;
}

/**
 * Fail-closed baseline handling: a missing or unreadable old
 * patch body means the drift comparison CANNOT run, so under
 * `--refuse-foreign-drift` the patch is refused rather than written on the
 * strength of a check that never happened. Without the flag this stays the
 * historical advisory skip (the preview is best-effort there).
 */
function refuseUnreadableBaseline(
  ctx: ForeignDriftContext,
  patchFilename: string,
  detail: string
): boolean {
  if (!ctx.refuseForeignDrift) {
    verbose(`Skipping foreign-drift preview for ${patchFilename}: ${detail}`);
    return false;
  }
  ctx.refusals.push({ patchFilename, files: [], reason: 'baseline-unreadable' });
  warn(
    `${patchFilename}: skipped (--refuse-foreign-drift) — ${detail}; the drift comparison cannot run, refusing fail-closed.`
  );
  return true;
}
