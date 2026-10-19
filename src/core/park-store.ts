// SPDX-License-Identifier: EUPL-1.2
/**
 * Storage and merge logic behind `fireforge park`.
 *
 * Several sessions edit the same Hominis files on one engine, and a peer's
 * `re-export --refuse-foreign-drift` refuses while another session's hunks
 * sit in its patch's files. Setting those hunks aside meant reversing each
 * one by hand. A park records, for every file of one patch that drifted:
 *
 *  - `before`: the file as the session left it (what the park takes away),
 *  - `after`: what the park writes in its place (the queue-applied
 *    baseline, or the working tree minus the named hunks).
 *
 * Restoring is a three-way merge of the file as it is now (ours) with
 * `before` (theirs) over `after` (base), so the owner's commit in between
 * is kept and the parked hunks come back on top of it.
 *
 * A park lives under `.fireforge/park/<label>/`: `park.json` plus one copy
 * of each side per file. Absent files are recorded as absent, never as
 * empty.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { InvalidArgumentError } from '../errors/base.js';
import { getNodeErrorCode } from '../utils/errors.js';
import {
  ensureDir,
  pathExists,
  readJson,
  readText,
  removeFile,
  writeJson,
  writeText,
} from '../utils/fs.js';
import { exec } from '../utils/process.js';
import { FIREFORGE_DIR } from './config-paths.js';

/** One parked file: both sides, null meaning absent. */
export interface ParkedFile {
  /** Engine-relative path. */
  path: string;
  /** The file as the session left it. */
  before: string | null;
  /** The file the park wrote in its place. */
  after: string | null;
}

/** The record of one park. */
export interface ParkRecord {
  label: string;
  /** The patch whose files were parked. */
  patch: string;
  createdAt: string;
  /** `baseline` parks every drifted hunk, `hunks` only those a diff named. */
  mode: 'baseline' | 'hunks';
  files: ParkedFile[];
}

/** What `park.json` holds: the record without file contents. */
interface ParkIndex extends Omit<ParkRecord, 'files'> {
  files: { path: string; before: boolean; after: boolean }[];
}

/** The outcome of restoring one file. */
export type RestoreOutcome = 'restored' | 'unchanged' | 'merged' | 'conflict';

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The directory holding every park of a project. */
function parkRoot(projectRoot: string): string {
  return join(projectRoot, FIREFORGE_DIR, 'park');
}

/** Refuses a label that is not a plain file-name segment. */
function assertParkLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new InvalidArgumentError(
      `Park label "${label}" must be letters, digits, ".", "_" or "-", starting with a letter or digit.`,
      '--label'
    );
  }
}

function sideDir(dir: string, side: 'before' | 'after'): string {
  return join(dir, side);
}

/** Writes a park; refuses to overwrite an existing label. */
export async function writePark(projectRoot: string, record: ParkRecord): Promise<string> {
  assertParkLabel(record.label);
  const dir = join(parkRoot(projectRoot), record.label);
  if (await pathExists(dir)) {
    throw new InvalidArgumentError(
      `A park named "${record.label}" already exists. Restore or drop it first, or pass another --label.`,
      '--label'
    );
  }
  for (const file of record.files) {
    for (const side of ['before', 'after'] as const) {
      const content = file[side];
      if (content === null) continue;
      const target = join(sideDir(dir, side), file.path);
      await ensureDir(dirname(target));
      await writeText(target, content);
    }
  }
  const index: ParkIndex = {
    label: record.label,
    patch: record.patch,
    createdAt: record.createdAt,
    mode: record.mode,
    files: record.files.map((file) => ({
      path: file.path,
      before: file.before !== null,
      after: file.after !== null,
    })),
  };
  await writeJson(join(dir, 'park.json'), index);
  return dir;
}

/** Reads a park back, contents included. */
export async function readPark(projectRoot: string, label: string): Promise<ParkRecord> {
  assertParkLabel(label);
  const dir = join(parkRoot(projectRoot), label);
  if (!(await pathExists(join(dir, 'park.json')))) {
    throw new InvalidArgumentError(
      `No park named "${label}". List them with "fireforge park --list".`,
      label
    );
  }
  const index = await readJson<ParkIndex>(join(dir, 'park.json'));
  const files: ParkedFile[] = [];
  for (const entry of index.files) {
    files.push({
      path: entry.path,
      before: entry.before ? await readText(join(sideDir(dir, 'before'), entry.path)) : null,
      after: entry.after ? await readText(join(sideDir(dir, 'after'), entry.path)) : null,
    });
  }
  return { ...index, files };
}

/** Every park of the project, oldest first. */
export async function listParks(projectRoot: string): Promise<ParkIndex[]> {
  let names: string[];
  try {
    names = (await readdir(parkRoot(projectRoot), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const parks: ParkIndex[] = [];
  for (const name of names) {
    const path = join(parkRoot(projectRoot), name, 'park.json');
    if (await pathExists(path)) parks.push(await readJson<ParkIndex>(path));
  }
  return parks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Deletes a park. */
export async function dropPark(projectRoot: string, label: string): Promise<void> {
  assertParkLabel(label);
  const dir = join(parkRoot(projectRoot), label);
  if (!(await pathExists(dir))) {
    throw new InvalidArgumentError(`No park named "${label}".`, label);
  }
  await rm(dir, { recursive: true, force: true });
}

/** Reads an engine file, null when absent. */
export async function readEngineFile(engineDir: string, path: string): Promise<string | null> {
  const full = join(engineDir, path);
  return (await pathExists(full)) ? await readText(full) : null;
}

/** Writes an engine file, removing it for null. */
export async function writeEngineFile(
  engineDir: string,
  path: string,
  content: string | null
): Promise<void> {
  const full = join(engineDir, path);
  if (content === null) {
    if (await pathExists(full)) await removeFile(full);
    return;
  }
  await ensureDir(dirname(full));
  await writeText(full, content);
}

/**
 * Three-way merges `ours` and `theirs` over `base` with `git merge-file`.
 * Conflicts come back as marker blocks.
 */
export async function mergeThreeWay(
  ours: string,
  base: string,
  theirs: string,
  path: string
): Promise<{ content: string; conflicts: number }> {
  const scratch = await mkdtemp(join(tmpdir(), 'fireforge-park-'));
  try {
    const files = {
      ours: join(scratch, 'ours'),
      base: join(scratch, 'base'),
      theirs: join(scratch, 'theirs'),
    };
    await writeFile(files.ours, ours);
    await writeFile(files.base, base);
    await writeFile(files.theirs, theirs);
    const result = await exec('git', [
      'merge-file',
      '-p',
      '-L',
      `${path} (now)`,
      '-L',
      `${path} (parked from)`,
      '-L',
      `${path} (parked)`,
      files.ours,
      files.base,
      files.theirs,
    ]);
    if (result.exitCode < 0 || result.exitCode > 127) {
      throw new Error(`git merge-file failed for ${path}: ${result.stderr.trim()}`);
    }
    return { content: result.stdout, conflicts: result.exitCode };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * What restoring one parked file writes: `before` when the file is still
 * as the park left it, nothing when it already matches `before`, and a
 * three-way merge otherwise. Absence only merges with absence.
 */
export async function planRestore(
  file: ParkedFile,
  now: string | null
): Promise<{ outcome: RestoreOutcome; content: string | null }> {
  if (now === file.after) return { outcome: 'restored', content: file.before };
  if (now === file.before) return { outcome: 'unchanged', content: now };
  if (now === null || file.before === null || file.after === null) {
    return { outcome: 'conflict', content: now };
  }
  const merged = await mergeThreeWay(now, file.after, file.before, file.path);
  return { outcome: merged.conflicts > 0 ? 'conflict' : 'merged', content: merged.content };
}

/** Message ids a Fluent file's lines declare (`id = …`, `-term = …`). */
export function fluentIds(lines: readonly string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    const match = /^(-?[A-Za-z][\w-]*)\s*=/.exec(line);
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

/** Lines `before` has that `after` lacks, as a multiset difference. */
export function removedLines(before: string | null, after: string | null): string[] {
  const remaining = new Map<string, number>();
  for (const line of (after ?? '').split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const removed: string[] = [];
  for (const line of (before ?? '').split('\n')) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else removed.push(line);
  }
  return removed;
}
