// SPDX-License-Identifier: EUPL-1.2
/**
 * Teardown reaper for the helper processes one mach test dispatch launched.
 *
 * The mochitest harness starts its httpd (`xpcshell … server.js`), the
 * websocket server, ssltunnel and the websocket/process bridge as plain
 * children, and the browser through mozprocess, which puts it in a process
 * group of its own. It logs each launch as `runtests.py | <what> pid: <n>`.
 * When mach dies before its own cleanup runs (a forwarded SIGTERM, a
 * no-output timeout, a harness crash, a supervisor kill), the helpers do not
 * necessarily die with it: an httpd can reparent to launchd and spin at 100%
 * CPU for hours.
 *
 * The exec layer terminates the dispatch's owned tree when mach exits: the
 * group, plus self-detached descendants whose command line names the objdir.
 * This module covers what that sampling missed. {@link createHelperPidTracker}
 * collects the announced pids from the streamed output, and
 * {@link reapTrackedHarnessPids} runs after mach has exited. Termination
 * requires the PID/start identity captured at the launch announcement, plus the
 * exact configured objdir and expected helper shape. The identity is checked
 * again before escalation, so a recycled PID is skipped.
 *
 * Not every helper is announced: mozserve starts `moz-http2` with
 * `start_new_session=True` and logs no pid. An unannounced helper the sampler
 * did not see stays with the preflight census, which reports it: a reparented,
 * path-shaped process cannot be told from a concurrent peer's helper.
 *
 * A FireForge killed outright runs no teardown, so each dispatch also keeps what
 * the harness announced in a ledger under `.fireforge/`, removed when the dispatch
 * ends. A later run under a `test.reapOrphans` reap posture terminates what a
 * ledger names once its writer is gone: the record is the same positive ownership
 * the writer's own teardown would have acted on.
 */

import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { FireForgeConfig } from '../types/config.js';
import { getNodeErrorCode, isProcessAlive, toError } from '../utils/errors.js';
import { dispatchCompleteLines } from '../utils/line-dispatch.js';
import { info, verbose } from '../utils/logger.js';
import {
  type ProcessBirth,
  processHasExitedAsync,
  processIdentity,
  sameProcess,
} from '../utils/process-birth.js';
import { listProcesses } from '../utils/process-list.js';
import {
  isObjdirAnchored,
  matchesHarnessHelper,
  terminateHarnessProcesses,
} from './harness-orphans.js';

/** What the harness said it launched, as it names it in the log line. */
export type TrackedHarnessKind =
  'Server' | 'Websocket server' | 'SSL tunnel' | 'websocket/process bridge' | 'Application';

/** One helper the harness launched. */
export interface TrackedHarnessPid {
  pid: number;
  kind: TrackedHarnessKind;
  /** Kernel start identity captured when this run observed the launch announcement. */
  identity?: ProcessBirth;
}

/**
 * Whether this run asked for the helpers of dead runs to be terminated:
 * `--reap-orphans`, or `test.reapOrphans` set to `"reap"` or `"owned"`.
 *
 * @param options - The run's options
 * @param config - Loaded project config
 */
export function wantsOrphanReap(
  options: { reapOrphans?: boolean | undefined },
  config: FireForgeConfig
): boolean {
  const posture = config.test?.reapOrphans;
  return options.reapOrphans === true || posture === 'reap' || posture === 'owned';
}

/** Where a project's helper ledgers live. */
function helperLedgerDir(projectRoot: string): string {
  return join(projectRoot, '.fireforge', 'harness-helpers');
}

/** One dispatch's durable record of what the harness announced. */
export interface HelperLedger {
  record(helper: TrackedHarnessPid): void;
  /** Removes the ledger: the dispatch's own teardown has run. */
  close(): void;
}

let helperLedgerSequence = 0;

/**
 * Opens a dispatch's ledger. Best-effort: a ledger that cannot be written only
 * means a later run cannot claim these helpers, and the census reports them.
 *
 * @param projectRoot - Project root
 * @returns The ledger, or undefined when this process has no readable identity
 */
export function openHelperLedger(projectRoot: string): HelperLedger | undefined {
  const owner = processIdentity(process.pid);
  if (owner === undefined) return undefined;
  helperLedgerSequence += 1;
  const dir = helperLedgerDir(projectRoot);
  const file = join(dir, `${owner.pid}-${helperLedgerSequence}.jsonl`);
  let opened = false;
  const append = (line: object): void => {
    try {
      if (!opened) {
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, `${JSON.stringify({ owner })}\n`);
        opened = true;
      }
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (error: unknown) {
      verbose(`Could not record a harness helper in ${file}: ${toError(error).message}`);
    }
  };
  return {
    record: append,
    close() {
      if (opened) rmSync(file, { force: true });
    },
  };
}

/** A ledger's writer and helpers, or undefined when the file is not one. */
function parseHelperLedger(
  text: string
): { owner: ProcessBirth; helpers: TrackedHarnessPid[] } | undefined {
  const records: unknown[] = [];
  for (const line of text.split('\n')) {
    try {
      if (line !== '') records.push(JSON.parse(line));
    } catch {
      // A writer killed mid-append leaves a partial last line.
    }
  }
  const [first, ...rest] = records as Array<{ owner?: ProcessBirth } & TrackedHarnessPid>;
  if (first?.owner === undefined) return undefined;
  return { owner: first.owner, helpers: rest };
}

/**
 * Settles the ledgers runs left behind. Only a ledger whose writer is gone is
 * touched, so a live run keeps its helpers whatever posture this run has. With
 * `reap`, the helpers it names are terminated under the same identity, objdir and
 * shape checks as a dispatch's own teardown. A ledger none of whose helpers
 * survive is removed either way.
 *
 * @param projectRoot - Project root
 * @param objDir - This project's absolute objdir
 * @param options - `reap` is the `reapOrphans` posture
 * @returns How many survivors are confirmed gone afterwards
 */
export async function settleDeadRunHelpers(
  projectRoot: string,
  objDir: string | undefined,
  options: { reap: boolean }
): Promise<number> {
  const dir = helperLedgerDir(projectRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') {
      verbose(`Could not read harness helper ledgers: ${toError(error).message}`);
    }
    return 0;
  }
  let reaped = 0;
  for (const name of names) {
    const file = join(dir, name);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const ledger = parseHelperLedger(text);
    if (ledger !== undefined && !(await processHasExitedAsync(ledger.owner))) continue;
    if (ledger !== undefined && options.reap) {
      reaped += await reapTrackedHarnessPids(ledger.helpers, objDir);
    }
    const exited = await Promise.all(
      (ledger?.helpers ?? []).map(async (helper) =>
        helper.identity === undefined ? true : processHasExitedAsync(helper.identity)
      )
    );
    if (exited.every(Boolean)) await rm(file, { force: true });
  }
  return reaped;
}

/** Which child stream a chunk came from. */
export type OutputStreamName = 'stdout' | 'stderr';

/**
 * The launch announcements in `testing/mochitest/runtests.py`. mozlog puts a
 * timestamp and level in front, so the match is unanchored.
 */
const HARNESS_PID_LINE =
  /runtests\.py \| (Server|Websocket server|SSL tunnel|websocket\/process bridge|Application) pid: (\d+)\b/;

/** Collects harness launch announcements from streamed output chunks. */
export interface HelperPidTracker {
  /** Feed one chunk. Chunk boundaries need not align with lines. */
  feed(stream: OutputStreamName, chunk: string): void;
  /** Every pid announced so far, in announcement order, without duplicates. */
  tracked(): TrackedHarnessPid[];
}

/**
 * Creates a tracker for one dispatch. The two streams are buffered apart so
 * a half-line on one cannot be glued to a half-line on the other.
 *
 * @param onTracked - Called with each helper as it is first announced
 */
export function createHelperPidTracker(
  onTracked?: (helper: TrackedHarnessPid) => void
): HelperPidTracker {
  const seen = new Map<number, TrackedHarnessPid>();
  const partial: Record<OutputStreamName, string> = { stdout: '', stderr: '' };
  const onLine = (line: string): void => {
    const match = HARNESS_PID_LINE.exec(line);
    if (!match) return;
    const pid = Number(match[2]);
    if (!seen.has(pid)) {
      const identity = processIdentity(pid);
      const helper: TrackedHarnessPid = {
        pid,
        kind: match[1] as TrackedHarnessKind,
        ...(identity === undefined ? {} : { identity }),
      };
      seen.set(pid, helper);
      if (identity !== undefined) onTracked?.(helper);
    }
  };
  return {
    feed(stream, chunk): void {
      partial[stream] = dispatchCompleteLines(partial[stream] + chunk, onLine);
    },
    tracked(): TrackedHarnessPid[] {
      return [...seen.values()];
    },
  };
}

/** Log prefix for every line this reaper writes. */
const TEARDOWN_LABEL = 'harness teardown';

/**
 * Decides whether a `ps` row still describes the process the harness
 * announced. Exported for fixture tests.
 *
 * The helpers must match the census's helper pattern and the objdir anchor.
 * The browser has no helper-shaped name, so the anchor alone attributes it:
 * its binary lives under the objdir (`<objdir>/dist/<App>.app/…`).
 */
export function isStillTrackedProcess(
  tracked: TrackedHarnessPid,
  command: string,
  objDir: string | undefined
): boolean {
  if (!isObjdirAnchored(command, objDir)) return false;
  return tracked.kind === 'Application' || matchesHarnessHelper(command);
}

/**
 * Re-reads the announced pids that are still alive and keeps the ones still
 * attributable to this dispatch. Empty when `ps` is unusable.
 */
async function survivingTrackedPids(
  tracked: readonly TrackedHarnessPid[],
  objDir: string | undefined
): Promise<TrackedHarnessPid[]> {
  const alive = tracked.filter(
    (entry) =>
      entry.identity !== undefined && sameProcess(entry.identity) && isProcessAlive(entry.pid)
  );
  if (alive.length === 0) return [];
  let commands: Map<number, string>;
  try {
    const rows = await listProcesses(['pid', 'command'] as const, {
      pids: alive.map((entry) => entry.pid),
    });
    commands = new Map(rows.map((row) => [row.pid, row.command]));
  } catch (error: unknown) {
    verbose(
      `${TEARDOWN_LABEL}: could not read ps for tracked helpers (${toError(error).message}); skipping.`
    );
    return [];
  }
  const targets: TrackedHarnessPid[] = [];
  for (const entry of alive) {
    const command = commands.get(entry.pid);
    if (command === undefined) continue; // exited between the probe and ps
    if (!isStillTrackedProcess(entry, command, objDir)) {
      verbose(
        `${TEARDOWN_LABEL}: PID ${entry.pid} (announced as ${entry.kind}) is now "${command.slice(0, 120)}", ` +
          'not attributable to this run; left alone.'
      );
      continue;
    }
    targets.push(entry);
  }
  return targets;
}

/**
 * Terminates every announced process of this dispatch that is still alive after
 * mach exited and still attributable to the dispatch.
 *
 * Best-effort like the census: a host without `ps` logs at verbose and reaps
 * nothing rather than signalling on the strength of a pid alone.
 *
 * @param tracked - The pids the harness announced during the dispatch
 * @param objDir - This project's absolute objdir, for the anchor rule
 * @returns How many survivors are confirmed gone afterwards
 */
export async function reapTrackedHarnessPids(
  tracked: readonly TrackedHarnessPid[],
  objDir: string | undefined
): Promise<number> {
  if (process.platform === 'win32') return 0;
  const targets = await survivingTrackedPids(tracked, objDir);
  if (targets.length === 0) return 0;

  info(
    `${TEARDOWN_LABEL}: ${targets.length} harness process(es) outlived mach ` +
      `(${targets.map((target) => `${target.kind} ${target.pid}`).join(', ')}); terminating.`
  );
  const identities = new Map(targets.map((target) => [target.pid, target.identity]));
  return terminateHarnessProcesses(targets, TEARDOWN_LABEL, (pid) => {
    const identity = identities.get(pid);
    return identity !== undefined && sameProcess(identity);
  });
}
