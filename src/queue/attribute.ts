// SPDX-License-Identifier: EUPL-1.2
/**
 * Which patch an edit belongs to, when several patches change the edited
 * file: the one whose lines the edit touches.
 *
 * Each patch's lines are the lines it adds that survive into the file the
 * queue produces, found by diffing the file's state before and after each
 * patch and following each added line through the later patches. An edit
 * (the diff from that file to the engine's) touches the lines it removes or
 * replaces, and for a pure insertion the lines on either side of it. When
 * every touched line that any patch owns belongs to one patch, the edit is
 * that patch's; otherwise (no patch's lines, or several) there is no answer
 * and the caller falls back to its default owner. An absent file reads as
 * empty. Binary content has no lines and never has an answer.
 */
import { type Hunk, parsePatch } from '../diff/index.js';
import { diffTrees, writeTree } from '../git/index.js';
import type { TreeState } from './apply.js';
import type { PathHistoryEntry, Projection } from './baseline.js';

/** Line numbers are 1-based. A hunk with no old lines names the line before it. */
function oldStartOf(hunk: Hunk): number {
  return hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
}

/** Where old line `line` is in the new file, or undefined when the hunks remove or replace it. */
function follow(hunks: readonly Hunk[], line: number): number | undefined {
  let offset = 0;
  for (const hunk of hunks) {
    const start = oldStartOf(hunk);
    if (line < start) break;
    if (line >= start + hunk.oldCount) {
      offset += hunk.newCount - hunk.oldCount;
      continue;
    }
    let old = start;
    let next = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    for (const body of hunk.lines) {
      const marker = body.charAt(0);
      if (marker === '+') next += 1;
      else if (marker === '-') {
        if (old === line) return undefined;
        old += 1;
      } else if (marker !== '\\') {
        if (old === line) return next;
        old += 1;
        next += 1;
      }
    }
    return undefined;
  }
  return line + offset;
}

/** The new-file line numbers of the lines the hunks add. */
function addedLines(hunks: readonly Hunk[]): number[] {
  const added: number[] = [];
  for (const hunk of hunks) {
    let next = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    for (const body of hunk.lines) {
      const marker = body.charAt(0);
      if (marker === '+') added.push(next);
      if (marker !== '-' && marker !== '\\') next += 1;
    }
  }
  return added;
}

/** The old-file lines an edit touches: those it removes, and the neighbours of an insertion. */
function touchedLines(hunks: readonly Hunk[]): Set<number> {
  const touched = new Set<number>();
  for (const hunk of hunks) {
    let old = oldStartOf(hunk);
    let previous = '';
    for (const body of hunk.lines) {
      const marker = body.charAt(0);
      if (marker === '\\') continue;
      if (marker === '-') {
        touched.add(old);
        old += 1;
      } else if (marker === '+') {
        if (previous !== '+' && previous !== '-') {
          touched.add(old - 1);
          touched.add(old);
        }
      } else old += 1;
      previous = marker;
    }
  }
  return touched;
}

/** Diffs one path between two states (absent reads as empty); undefined for binary content. */
async function lineHunks(
  engine: string,
  path: string,
  from: TreeState | null,
  to: TreeState | null
): Promise<Hunk[] | undefined> {
  const tree = (state: TreeState | null): Promise<string> =>
    writeTree(engine, state === null ? [] : [{ path, oid: state.oid, mode: state.mode }]);
  const body = await diffTrees(engine, await tree(from), await tree(to), { paths: [path] });
  if (body.length === 0) return [];
  const [file] = parsePatch(body).files;
  return file === undefined || file.binary !== undefined ? undefined : [...file.hunks];
}

/** The patch whose lines an edit to one path touches, or undefined. */
async function ownerOf(
  engine: string,
  path: string,
  history: readonly PathHistoryEntry[],
  now: TreeState | null
): Promise<string | undefined> {
  const steps: Hunk[][] = [];
  for (let index = 1; index < history.length; index++) {
    const step = await lineHunks(
      engine,
      path,
      history[index - 1]?.state ?? null,
      history[index]?.state ?? null
    );
    if (step === undefined) return undefined;
    steps.push(step);
  }
  const owners = new Map<number, string>();
  for (const [index, step] of steps.entries()) {
    const patch = history[index + 1]?.patch;
    if (patch === undefined) continue;
    for (const added of addedLines(step)) {
      let line: number | undefined = added;
      for (const later of steps.slice(index + 1)) {
        if (line === undefined) break;
        line = follow(later, line);
      }
      if (line !== undefined) owners.set(line, patch);
    }
  }
  const edit = await lineHunks(engine, path, history.at(-1)?.state ?? null, now);
  if (edit === undefined) return undefined;
  const touched = new Set(
    [...touchedLines(edit)].flatMap((line) => {
      const owner = owners.get(line);
      return owner === undefined ? [] : [owner];
    })
  );
  return touched.size === 1 ? [...touched][0] : undefined;
}

/**
 * For each edited path more than one patch changes, the patch (by filename)
 * whose lines the edit touches, where exactly one does.
 *
 * @param engine - The engine checkout
 * @param projection - The queue's projection
 * @param edited - The engine's state of each edited path
 */
export async function attributeEdits(
  engine: string,
  projection: Projection,
  edited: ReadonlyMap<string, TreeState | null>
): Promise<Map<string, string>> {
  const attributed = new Map<string, string>();
  for (const [path, now] of edited) {
    const history = projection.history(path);
    if (new Set(history.flatMap((entry) => entry.patch ?? [])).size < 2) continue;
    const owner = await ownerOf(engine, path, history, now);
    if (owner !== undefined) attributed.set(path, owner);
  }
  return attributed;
}
