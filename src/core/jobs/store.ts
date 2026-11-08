// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import type { JobRecord } from './schema.js';

/** Durable file replacement: publish only after bytes and the containing directory are synced. */
export async function writeDurable(path: string, value: unknown): Promise<void> {
  return writeDurableBytes(path, `${JSON.stringify(value)}\n`);
}

/** Durable publication for generated owned executable assets, without JSON encoding. */
export async function writeDurableBytes(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    // On a full disk a retried write must not leave the bytes that keep it full.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** A coordinator namespace is private, owned by this UID and cannot be a symlink. */
export async function ensurePrivateNamespace(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error('Coordinator namespace must be an owned real directory');
  await chmod(directory, 0o700);
}

/** Whether a namespace was deleted out from under its supervisor. */
export async function namespaceGone(namespace: string): Promise<boolean> {
  try {
    await access(join(namespace, 'config.json'));
    return false;
  } catch (error) {
    return getNodeErrorCode(error) === 'ENOENT';
  }
}

/** Read structured state; callers validate its schema at their trust boundary. */
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Sizes a failed append could not truncate back to; the next append finishes the job. */
const tornJournals = new Map<string, number>();

/**
 * Append the complete transition before acknowledging a request. A failed
 * write leaves no partial bytes behind, so the next row never concatenates
 * onto a fragment that would make the journal unreadable at the next start.
 */
export async function appendTransition(namespace: string, job: JobRecord): Promise<void> {
  const path = join(namespace, 'journal.jsonl');
  const file = await open(path, 'a', 0o600);
  let size = tornJournals.get(path);
  try {
    if (size !== undefined) {
      await file.truncate(size);
      tornJournals.delete(path);
    }
    size = (await file.stat()).size;
    await file.writeFile(`${JSON.stringify(job)}\n`);
    await file.sync();
  } catch (error) {
    if (size !== undefined) {
      try {
        await file.truncate(size);
      } catch {
        tornJournals.set(path, size);
      }
    }
    throw error;
  } finally {
    await file.close();
  }
  const directory = await open(namespace, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** A journal row that cannot be read, and the job it names when it still shows one. */
export interface DamagedRow {
  /** One-based line in the journal it came from. */
  line: number;
  text: string;
  /** The job whose latest record this row was, so what it said is lost. */
  job?: string;
}

/** Where damaged rows go, so one bad row costs one job's record rather than the host. */
export const damagedJournalPath = (namespace: string): string =>
  join(namespace, 'journal.damaged.jsonl');

/** The job a row names, or undefined when it is no job's row. */
function parseJournalRow(row: string): JobRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(row);
  } catch {
    return undefined;
  }
  return raw !== null &&
    typeof raw === 'object' &&
    'schemaVersion' in raw &&
    raw.schemaVersion === 1 &&
    'id' in raw &&
    typeof raw.id === 'string'
    ? (raw as JobRecord)
    : undefined;
}

/**
 * The last durable state of every job, and the rows that could not be read. A
 * job's later rows supersede its earlier ones, so a damaged row costs something
 * only when no later row of that job survives.
 */
export async function readJournalContents(
  namespace: string,
  options: { repairTail?: boolean } = {}
): Promise<{ jobs: Map<string, JobRecord>; damaged: DamagedRow[] }> {
  const path = join(namespace, 'journal.jsonl');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return { jobs: new Map(), damaged: [] };
    throw error;
  }
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  if (options.repairTail === true && complete !== text)
    await truncate(path, Buffer.byteLength(complete));
  const jobs = new Map<string, JobRecord>();
  const latest = new Map<string, number>();
  const damaged: DamagedRow[] = [];
  const rows = complete.split('\n');
  rows.pop();
  rows.forEach((row, index) => {
    const job = parseJournalRow(row);
    if (job === undefined) damaged.push({ line: index + 1, text: row });
    else {
      jobs.set(job.id, job);
      latest.set(job.id, index + 1);
    }
  });
  for (const row of damaged) {
    const named = /"id":"([^"]+)"/.exec(row.text)?.[1];
    if (named !== undefined && (latest.get(named) ?? 0) < row.line) row.job = named;
  }
  return { jobs, damaged };
}

/** The last durable state of every job, never promoting interrupted work to passed. */
export async function readJournal(namespace: string): Promise<Map<string, JobRecord>> {
  return (await readJournalContents(namespace)).jobs;
}

/** Moves damaged rows out of the journal, once they are safely recorded beside it. */
export async function isolateDamagedRows(
  namespace: string,
  damaged: readonly DamagedRow[],
  jobs: Iterable<JobRecord>
): Promise<void> {
  const rows = damaged.map((row) => `${JSON.stringify({ line: row.line, text: row.text })}\n`);
  await appendFile(damagedJournalPath(namespace), rows.join(''), { mode: 0o600 });
  await compactJournal(namespace, jobs);
}

/** Replace the journal with one row per job, so replay cost follows live history. */
export async function compactJournal(namespace: string, jobs: Iterable<JobRecord>): Promise<void> {
  const rows = [...jobs].map((job) => `${JSON.stringify(job)}\n`).join('');
  await writeDurableBytes(join(namespace, 'journal.jsonl'), rows);
}

/** A slot's private directory. Slot names cannot escape the namespace. */
export function slotDirectory(namespace: string, id: string): string {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid slot name');
  return join(namespace, 'slots', id);
}
