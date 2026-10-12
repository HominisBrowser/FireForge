// SPDX-License-Identifier: EUPL-1.2
/**
 * Foreign-drift preview + `--refuse-foreign-drift` gate for `re-export`.
 *
 * A scan-less re-export rebuilds each patch body as a whole-file
 * `git diff HEAD` over the owned files, so a concurrent session's
 * uncommitted lines inside a file the patch already owns are silently
 * absorbed into the refreshed body. The adjacency advisory
 * (`re-export-adjacent.ts`) warns about unmanaged neighbour files but is
 * structurally blind to drift inside owned files. This module compares
 * the old body against the refreshed body per file and reports the
 * payload lines that are about to enter or leave the body. Under
 * `--refuse-foreign-drift` the patch is skipped and the run exits
 * non-zero, mirroring `--refuse-adjacent-unmanaged`.
 *
 * "Foreign" is decided by content, not authorship: re-export's legitimate
 * job is capturing intentional engine edits, so the preview always prints
 * and the hard stop is an explicit opt-in for multi-session checkouts.
 * The comparison is offset-insensitive, using per-file multisets of `+`/`-`
 * payload lines, because a refresh legitimately shifts hunk offsets and
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

/**
 * One owned file's foreign drift between the old and refreshed body,
 * counted as edits to the engine file rather than as body payload, so a
 * deletion-only change is drift like any other.
 */
export interface FileForeignDrift {
  file: string;
  /**
   * Lines the engine file gained since the old body: `+` payload the new
   * body carries that the old did not, plus `-` payload the old body carried
   * that the new one dropped (an upstream line restored).
   */
  addedLines: number;
  /**
   * Lines the engine file lost since the old body: `-` payload the new body
   * carries that the old did not, plus `+` payload the old body carried that
   * the new one dropped (a line the patch added, now deleted).
   */
  removedLines: number;
  /** `@@` headers of the hunks carrying those lines (capped). */
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

/**
 * Summarizes the hunks of `payload` that carry the budgeted `+`/`-` lines.
 * `describe` renders the per-hunk counts, so the old body's dropped lines
 * read in the same engine-edit direction as the new body's absorbed ones.
 */
function summarizeForeignHunks(
  payload: FilePayload | undefined,
  foreignAdded: ReadonlyMap<string, number>,
  foreignRemoved: ReadonlyMap<string, number>,
  describe: (plus: number, minus: number) => string
): string[] {
  const summaries: string[] = [];
  if (payload === undefined) return summaries;
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
          `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${describe(added, removed)}`
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

const EMPTY_PAYLOAD_LINES: ReadonlyMap<string, number> = new Map();

/**
 * Pure comparison: per owned file, which `+`/`-` payload lines the
 * refreshed body carries that the old body did not, and which the old body
 * carried that the refreshed one dropped. Both directions are drift: a
 * concurrent session deleting a line the patch added changes the patch as
 * surely as one adding a line, and a belt that only saw absorbed lines let
 * such a deletion through silently. Files not in `previousFilesAffected`
 * are skipped, since those are intentional adoptions (`--scan`) or
 * retirements (`--expect-removed`) rather than drift.
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
  // New-body order first, then files only the old body carried.
  const files = new Set([...newByFile.keys(), ...oldByFile.keys()]);

  for (const file of files) {
    if (!owned.has(file)) continue;
    const next = newByFile.get(file);
    const previous = oldByFile.get(file);
    if (next?.isBinary === true || previous?.isBinary === true) {
      if (binaryContentChanged(next, previous)) {
        drift.push({
          file,
          addedLines: 0,
          removedLines: 0,
          hunkSummaries: [],
          binaryChanged: true,
        });
      }
      continue;
    }
    const absorbedAdded = multisetExcess(
      next?.added ?? EMPTY_PAYLOAD_LINES,
      previous?.added ?? EMPTY_PAYLOAD_LINES
    );
    const absorbedRemoved = multisetExcess(
      next?.removed ?? EMPTY_PAYLOAD_LINES,
      previous?.removed ?? EMPTY_PAYLOAD_LINES
    );
    const droppedAdded = multisetExcess(
      previous?.added ?? EMPTY_PAYLOAD_LINES,
      next?.added ?? EMPTY_PAYLOAD_LINES
    );
    const droppedRemoved = multisetExcess(
      previous?.removed ?? EMPTY_PAYLOAD_LINES,
      next?.removed ?? EMPTY_PAYLOAD_LINES
    );
    const addedLines = countExcess(absorbedAdded) + countExcess(droppedRemoved);
    const removedLines = countExcess(absorbedRemoved) + countExcess(droppedAdded);
    if (addedLines === 0 && removedLines === 0) continue;
    drift.push({
      file,
      addedLines,
      removedLines,
      hunkSummaries: [
        ...summarizeForeignHunks(
          next,
          absorbedAdded,
          absorbedRemoved,
          (plus, minus) => `(+${plus}/-${minus})`
        ),
        // A dropped `+` line is one the engine lost; a dropped `-` line is an
        // upstream line the engine has back.
        ...summarizeForeignHunks(
          previous,
          droppedAdded,
          droppedRemoved,
          (plus, minus) => `in the old body, dropped (+${minus}/-${plus})`
        ),
      ].slice(0, MAX_HUNK_SUMMARIES_PER_FILE),
      binaryChanged: false,
    });
  }

  return drift;
}

/** True when a binary section appeared, vanished, or its new-side blob hash moved. */
function binaryContentChanged(
  next: FilePayload | undefined,
  previous: FilePayload | undefined
): boolean {
  if (next?.binaryNewHash === undefined || previous?.binaryNewHash === undefined) return true;
  return !(
    next.binaryNewHash.startsWith(previous.binaryNewHash) ||
    previous.binaryNewHash.startsWith(next.binaryNewHash)
  );
}

/**
 * Reads the old body, prints the always-on drift preview (including under
 * dry-run and `--scan`), and, when `ctx.refuseForeignDrift` is set,
 * records a refusal and returns `true` so the caller skips the write.
 */
export async function reportForeignDrift(args: {
  patch: PatchMetadata;
  patchesDir: string;
  engineDir: string;
  newDiffContent: string;
  ctx: ForeignDriftContext;
  /**
   * The patch's files that the comparison covers. Defaults to its
   * `filesAffected`; the caller narrows it by the `--expect-removed`
   * retirements, which leave the body on purpose.
   */
  ownedFiles?: readonly string[];
  /**
   * Files a `--scan`/`--scan-file` adoption brings in this run. They sit
   * outside the comparison (nothing to compare against) and count as
   * expected, so naming one in `--expect` is not reported as unseen.
   */
  adoptedFiles?: readonly string[];
}): Promise<boolean> {
  const { patch, patchesDir, engineDir, newDiffContent, ctx } = args;
  for (const file of args.adoptedFiles ?? []) {
    if (ctx.expectedDriftFiles.has(file)) ctx.expectedSeen.add(file);
  }
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

  const drift = computeForeignDrift(
    oldBody,
    newDiffContent,
    args.ownedFiles ?? patch.filesAffected
  );
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
    `${patch.filename}: refreshed body changes ${totalLines} ${lineNoun} against the old patch body (${drift.length} file(s)):`
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
      `  ${entry.file}: +${entry.addedLines} added / -${entry.removedLines} removed line(s)${expectedTag}${authorshipTag}`
    );
    for (const summary of entry.hunkSummaries) {
      info(`    ${summary}`);
    }
  }
  if (drift.length > MAX_FILES_REPORTED) {
    info(`  +${drift.length - MAX_FILES_REPORTED} more file(s)`);
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
 * "foreign", including the operator's own additions from the same session,
 * and "foreign" reads as "another session's", which is the case where
 * proceeding would be wrong. Authorship is unknowable, but recency is not:
 * a file whose mtime is newer than the patch body this run is refreshing
 * changed after the last export, which on a single-operator slice is the
 * operator's own edit. Returns the subset of `files` that qualifies. An
 * unstattable path is reported as not recently edited, so the cautious
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
 * patch body means the drift comparison cannot run, so under
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

/**
 * States, verbatim in the notice, what the `--expect` whitelist is compared
 * against and when. This notice is the only feedback an operator gets that
 * the drift belt looked at the files they named, so it has to describe the
 * measurement exactly:
 *
 *  - Compared: for each file already in the patch's `filesAffected`, the
 *    `+`/`-` payload lines the refreshed body carries that the old patch
 *    body did not, and the ones the old body carried that the refreshed body
 *    dropped (`computeForeignDrift`). It is a content comparison in both
 *    directions, so a deletion-only edit is drift too.
 *  - When: per patch, on the body about to be written, before the write.
 *    Never against post-write state.
 *
 * An earlier copy compared one direction only, so a correctly captured
 * deletion read as an `--expect` that matched nothing, and a peer's
 * deletion in a file outside `--expect` passed the belt silently.
 */
const EXPECT_MEASUREMENT_NOTE =
  '--expect is evaluated against CONTENT, before the write: for each file already in the ' +
  "patch's filesAffected, the payload lines the refreshed body adds or drops against the old " +
  'patch body. It never looks at post-write state.';

/**
 * Names `--expect` paths that never drifted this run. A typo'd
 * `--expect` path silently degrades the flag back to refusing the slice it
 * was meant to admit, so surface the mismatch, but only as a warning: an
 * expected file legitimately shows no drift in several shapes, all named
 * below.
 */
export function warnUnseenExpectedDrift(driftCtx: ForeignDriftContext): void {
  const unseen = [...driftCtx.expectedDriftFiles].filter(
    (file) => !driftCtx.expectedSeen.has(file)
  );
  if (unseen.length === 0) return;
  if (driftCtx.evaluationRuns === 0) {
    warn(
      `--expect path(s) were not evaluated because no selected patch reached the drift check (for example, an earlier refusal): ${unseen.join(', ')}`
    );
    return;
  }
  warn(
    '--expect path(s) showed no drift this run: ' +
      `${unseen.join(', ')}.\n` +
      `${EXPECT_MEASUREMENT_NOTE}\n` +
      'Causes, in rough order of likelihood:\n' +
      "  1. A typo in the path, or a path in none of the selected patches' filesAffected and " +
      'not adopted by this run.\n' +
      '  2. Adoption already captured it: a "re-export <p> --scan --scan-file <f>" run also ' +
      "captures that patch's other drifted files, so a scan-less re-export afterwards " +
      'legitimately sees nothing left to change. Informational — a chain that treats this ' +
      'warning as an error will false-red on it.\n' +
      '  3. The slice was already captured by an earlier export in this session.\n' +
      '  4. The engine content already matches the patch body — a concurrent session may have ' +
      'exported the same change, so the drift converged before this run looked.'
  );
}
