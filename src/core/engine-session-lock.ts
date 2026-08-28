// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { InconclusiveVerdictError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { info, warn } from '../utils/logger.js';
import type { LockHolder, LockQueueState } from './file-lock.js';
import { type LockStatusSnapshot, readLockStatus, withFileLock } from './file-lock.js';
import { git } from './git-base.js';

const ENGINE_SESSION_LOCK_PATH = join('.fireforge', 'engine-session.lock');

/**
 * How much longer than the requested budget a wait may run while its queue
 * position keeps improving, and the absolute ceiling on that. The ceiling
 * matches `--wait-lock`'s own upper bound: an operator who asked for a wait
 * never gets one longer than the largest wait they could have asked for.
 */
const WAIT_EXTENSION_FACTOR = 4;
const MAX_WAIT_LOCK_MS = 3600 * 1000;

export interface EngineSessionLockOptions {
  /**
   * Wait up to this many seconds for the engine session lock instead of the
   * ~1 s fail-fast. Enables exponential poll backoff (100 ms → 2 s) and a
   * holder-identified progress line roughly every 5 s. `undefined` keeps the
   * fail-fast behaviour.
   */
  waitLockSeconds?: number | undefined;
}

/**
 * Formats the periodic operator-facing waiting line printed while `--wait-lock`
 * polls a contended engine session lock. The holder identification comes from
 * the lock's owner-metadata lines (`command=…`, `started=…`); an unreadable
 * owner file degrades to the anonymous form.
 */
function formatWaitProgressLine(
  waitedMs: number,
  timeoutMs: number,
  holder: LockHolder | undefined,
  queue?: LockQueueState
): string {
  const progress = `${String(Math.round(waitedMs / 1000))}s of up to ${String(Math.round(timeoutMs / 1000))}s`;
  // Queue position: under several concurrent sessions the wait
  // line alone left operators inferring their place from `ps`.
  const position =
    queue === undefined || queue.depth === 0
      ? ''
      : queue.ahead === 0
        ? ` You are next in a queue of ${String(queue.depth)}.`
        : ` ${String(queue.ahead)} ahead of you (queue of ${String(queue.depth)}).`;
  if (holder === undefined) {
    return `Waiting for the FireForge engine lock — ${progress}.${position}`;
  }
  const details = holder.metadata.length > 0 ? ` (${holder.metadata.join(', ')})` : '';
  return `Waiting for the FireForge engine lock held by PID ${String(holder.pid)}${details} — ${progress}.${position}`;
}

/**
 * Formats the notice printed when the wait budget is EXTENDED because the
 * queue advanced.
 *
 * Exported for direct unit testing. It names both figures — the requested
 * budget and the one now in force — because the whole point is that the two
 * have diverged, and an operator comparing the elapsed time against the
 * number they typed would otherwise conclude the timeout is broken.
 */
export function formatWaitExtendedLine(
  ahead: number,
  budgetMs: number,
  requestedMs: number
): string {
  const position = ahead === 0 ? 'you are now next' : `${String(ahead)} still ahead of you`;
  return (
    `The queue advanced (${position}), so the engine-lock wait was extended to ` +
    `${String(Math.round(budgetMs / 1000))}s total (you asked for ` +
    `${String(Math.round(requestedMs / 1000))}s). A queue that stops moving still ` +
    `gives up on the budget you asked for.`
  );
}

/**
 * Runs `operation` while holding the project's engine-session lock, so only
 * one engine-mutating FireForge command touches `engine/` at a time.
 */
export async function withEngineSessionLock<T>(
  projectRoot: string,
  command: string,
  operation: () => Promise<T>,
  options: EngineSessionLockOptions = {}
): Promise<T> {
  // The lock is bypassed under test by default, and that is deliberate: the
  // suite runs many engine-mutating commands in-process, which would either
  // serialise on this lock or deadlock outright.
  // `FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST=1` lets the lock's own
  // tests opt back in. Do not delete this branch — it is the reason the
  // suite completes.
  if (
    process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] !== '1' &&
    (process.env['NODE_ENV'] === 'test' || process.env['VITEST'] !== undefined)
  ) {
    return operation();
  }
  const { waitLockSeconds } = options;
  return withFileLock(join(projectRoot, ENGINE_SESSION_LOCK_PATH), operation, {
    timeoutMs: waitLockSeconds !== undefined ? waitLockSeconds * 1000 : 1000,
    ...(waitLockSeconds !== undefined
      ? {
          pollMs: 100,
          pollMaxMs: 2000,
          waitProgressMs: 5000,
          onWaitProgress: ({ waitedMs, timeoutMs, holder, queue }): void => {
            info(formatWaitProgressLine(waitedMs, timeoutMs, holder, queue));
          },
          // Say it out loud. An extension is the moment the budget the
          // operator asked for stops being the budget in force, and a wait
          // that silently outlives its own stated timeout is
          // indistinguishable from a broken one — which is how a downstream
          // fork read it.
          onWaitExtended: ({ ahead, budgetMs }): void => {
            info(formatWaitExtendedLine(ahead, budgetMs, waitLockSeconds * 1000));
          },
          // A budget that expires one position from the head pays the whole
          // wait for nothing. While the queue is still MOVING the wait is
          // working, so each advance renews the budget — up to a hard
          // ceiling, so a pathological queue cannot wait forever. The
          // no-flag fail-fast path deliberately gets none of this.
          extendWhileAdvancing: {
            maxWaitMs: Math.min(waitLockSeconds * 1000 * WAIT_EXTENSION_FACTOR, MAX_WAIT_LOCK_MS),
          },
        }
      : {}),
    ownerMetadata: [`command=${command}`, `started=${new Date().toISOString()}`],
    // Reason first, remedy second — the no-flag default waits
    // only ~1 s, so contention is the common case and `--wait-lock` is the
    // genuine remedy. withFileLock appends the holder identification from
    // the lock's owner metadata. The leading sentence is a message contract
    // (pinned by engine-session-lock tests); extend, don't reword.
    onTimeoutMessage:
      `Another FireForge engine-mutating command is already running. ` +
      `Wait for it to finish, then retry \`${command}\` — or pass --wait-lock [seconds] ` +
      `to wait for the lock (bare --wait-lock waits up to 60 seconds). ` +
      `Set FIREFORGE_WAIT_LOCK=<seconds> to apply a budget to every command in a session.`,
    onStaleLockMessage: (ageMs) =>
      `Removed stale FireForge engine session lock (${Math.round(ageMs / 1000)}s old).`,
  });
}

/**
 * Inspects the project's engine-session lock without acquiring it —
 * backing `fireforge status --lock`.
 *
 * @param projectRoot - Project root containing `.fireforge/`
 * @returns Holder identity, hold duration, and queue depth
 */
export async function readEngineSessionLockStatus(
  projectRoot: string
): Promise<LockStatusSnapshot> {
  return readLockStatus(join(projectRoot, ENGINE_SESSION_LOCK_PATH));
}

/**
 * Renders the engine-session lock snapshot as operator-facing lines.
 * Pure, so the wording is unit-testable without a lock on disk.
 */
export function formatEngineSessionLockStatus(
  snapshot: LockStatusSnapshot,
  holderCpuSeconds?: number
): string[] {
  if (!snapshot.held) {
    return ['Engine session lock: free (no FireForge engine-mutating command is running).'];
  }
  const elapsed =
    snapshot.heldForMs === undefined
      ? 'unknown duration'
      : `${String(Math.round(snapshot.heldForMs / 1000))}s`;
  const holder = snapshot.holder;
  const identity =
    holder === undefined
      ? 'held by an unidentified process (no readable owner record)'
      : `held by PID ${String(holder.pid)}${holder.alive ? '' : ' (NOT RUNNING — stale lock)'}` +
        (holder.metadata.length > 0 ? ` (${holder.metadata.join(', ')})` : '');
  const lines = [
    `Engine session lock: ${identity}, for ${elapsed}.`,
    `Queue depth: ${String(snapshot.queueDepth)} waiter(s).`,
  ];
  // Liveness answers "does the process exist"; it does not answer "is it
  // getting anywhere". A holder alive for minutes having used a fraction of
  // a second of CPU is the shape of a wedged command, and every waiter
  // behind it inherits the stall. Stated as an observation with its own
  // caveat — a holder blocked on I/O is also idle, and this must not be read
  // as licence to kill anything.
  if (holder?.alive === true && holderCpuSeconds !== undefined) {
    const cpu = `${holderCpuSeconds.toFixed(1)}s`;
    const idle =
      snapshot.heldForMs !== undefined && snapshot.heldForMs > 60_000 && holderCpuSeconds < 2
        ? ' — near-zero CPU over a long hold, which is what a WEDGED command looks like; ' +
          'a holder blocked on I/O looks the same, so confirm before acting'
        : '';
    lines.push(`Holder CPU time: ${cpu}${idle}.`);
  }
  return lines;
}

/** Prefix marking a generation token whose probe failed. */
const UNAVAILABLE_PREFIX = 'unavailable:';

/**
 * Captures an opaque token describing the engine's current commit and working
 * tree, for comparison by {@link assertEngineGenerationUnchanged}.
 *
 * A failed probe yields a failure token. Callers must branch on
 * {@link isUnavailableGenerationToken} rather than comparing the token,
 * because a probe failure means "nothing was measured", not "nothing changed".
 */
export async function snapshotEngineGeneration(engineDir: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < GENERATION_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const head = (await git(['rev-parse', 'HEAD'], engineDir)).trim();
      const status = await git(['status', '--porcelain=v1', '-z'], engineDir);
      return `${head}\0${status}`;
    } catch (error: unknown) {
      lastError = error;
      // A contended `.git/index.lock` is TRANSIENT, not a state: some other
      // writer held the index for the instant we looked. Treating it as
      // "unmeasurable" turns a perfectly good suite into
      // `FAIL reason=inconclusive` on a one-sided probe failure. Anything
      // else — an unreadable `.git`, a non-git `engine/` — is a real state
      // and is reported immediately.
      if (!isIndexLockError(error) || attempt === GENERATION_PROBE_ATTEMPTS - 1) break;
      await delay(GENERATION_PROBE_RETRY_MS);
    }
  }
  return `${UNAVAILABLE_PREFIX}${toError(lastError).message}`;
}

/** Probe attempts before an engine generation is declared unmeasurable. */
const GENERATION_PROBE_ATTEMPTS = 3;

/** Pause between generation-probe attempts. */
const GENERATION_PROBE_RETRY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/**
 * True when a git failure is the transient index-lock contention shape
 * (`Unable to create '…/.git/index.lock': File exists`) rather than a
 * durable problem with the checkout. Exported for direct unit testing.
 */
export function isIndexLockError(error: unknown): boolean {
  const message = toError(error).message;
  return /index\.lock/i.test(message);
}

/**
 * True when a generation token records a failed probe — i.e. nothing was
 * measured, so the token must never be compared (or hashed) as if it
 * described the engine's state.
 */
export function isUnavailableGenerationToken(token: string): boolean {
  return token.startsWith(UNAVAILABLE_PREFIX);
}

/** Strips the marker prefix off an unavailable token for display. */
export function unavailableGenerationReason(token: string): string {
  return token.slice(UNAVAILABLE_PREFIX.length);
}

/** How many changed entries the delta names before truncating. */
const DELTA_ENTRY_LIMIT = 5;

/**
 * Splits a generation token into its HEAD and porcelain halves. The porcelain
 * body is `-z` output, so it is NUL-separated and never quoted.
 */
function splitGenerationToken(token: string): { head: string; body: string } {
  const separator = token.indexOf('\0');
  if (separator < 0) return { head: token, body: '' };
  return { head: token.slice(0, separator), body: token.slice(separator + 1) };
}

/**
 * Parses `git status --porcelain=v1 -z` into `XY path` records.
 *
 * The rename/copy shape is the trap: `R`/`C` entries are followed by a
 * SECOND NUL-separated field carrying the original path, and consuming only
 * one desynchronises every record after it — turning a one-file rename into
 * a report that the whole tree moved. Both fields are consumed and the
 * record renders as `orig -> new`.
 */
function parsePorcelainRecords(body: string): string[] {
  const fields = body.split('\0').filter((field) => field.length > 0);
  const records: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    // `XY ` — two status characters and a space — then the path.
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const origin = fields[i + 1];
      i += 1;
      records.push(`${status} ${origin ?? '?'} -> ${path}`);
      continue;
    }
    records.push(`${status} ${path}`);
  }
  return records;
}

/**
 * Describes what moved between two generation tokens, in operator terms.
 *
 * The refusal used to say only THAT the engine changed, which left the
 * operator to reconstruct the writer by hand — `find -newermt` against the
 * run window, minus the objdir, minus git's own bookkeeping. Everything
 * needed to answer it is already in the two tokens, so the refusal answers
 * it. Pure and total: an unparseable token yields an empty list rather than
 * an exception, because a diagnostic must never convert a refusal into a
 * crash.
 *
 * @param before - Token captured before the run
 * @param after - Token captured after the run
 * @returns Human-readable lines describing the delta; empty when nothing
 *   could be attributed
 */
export function describeEngineGenerationDelta(before: string, after: string): string[] {
  const lines: string[] = [];
  const from = splitGenerationToken(before);
  const to = splitGenerationToken(after);
  if (from.head !== to.head) {
    lines.push(`HEAD moved: ${from.head} -> ${to.head}`);
  }
  const beforeRecords = new Set(parsePorcelainRecords(from.body));
  const afterRecords = new Set(parsePorcelainRecords(to.body));
  const appeared = [...afterRecords].filter((record) => !beforeRecords.has(record)).sort();
  const disappeared = [...beforeRecords].filter((record) => !afterRecords.has(record)).sort();
  const render = (label: string, records: string[]): void => {
    if (records.length === 0) return;
    const head = records.slice(0, DELTA_ENTRY_LIMIT);
    const truncated = records.length - head.length;
    lines.push(
      `${label}: ${head.join(', ')}${truncated > 0 ? `, … (+${String(truncated)} more)` : ''}`
    );
  };
  render('Working-tree entries that appeared', appeared);
  render('Working-tree entries that went away', disappeared);
  return lines;
}

/**
 * Throws when the engine's generation token differs from `before`, i.e. the
 * engine was mutated by another writer while a test run was in flight.
 *
 * **An unmeasurable engine warns rather than throws.** `engine/` is not
 * always a git checkout — `fireforge download` extracts a source tarball —
 * so a failed probe is a legitimate state and must not fail the run.
 *
 * What it must also not do is pass *silently*. A failure token compared for
 * equality like any other would let a git failure that reproduces across
 * both probes (unreadable `.git`, a permissions problem, a corrupt index)
 * take the `after === before` early return and bless a verdict the guard
 * never verified. Two *differing* failure messages are worse still: they
 * fall through to the mutation branch and report a spurious
 * "engine/ changed". Hence the prefix comparison rather than a token
 * comparison — the token embeds the error message, and two genuine failures
 * rarely phrase it identically.
 *
 * The tolerance is deliberately limited to a probe that failed *both* times:
 * that is the steady state of a non-git `engine/`, and it warns. A one-sided
 * transition is not that state. An `engine/` that was measurable and then
 * was not means the second probe measured nothing about a checkout that
 * demonstrably had something to measure; the reverse means there was never a
 * baseline to compare against. Neither verdict can be trusted, so both throw.
 */
export async function assertEngineGenerationUnchanged(
  engineDir: string,
  before: string
): Promise<void> {
  const after = await snapshotEngineGeneration(engineDir);
  const beforeUnavailable = isUnavailableGenerationToken(before);
  const afterUnavailable = isUnavailableGenerationToken(after);

  if (beforeUnavailable && afterUnavailable) {
    warn(
      'Could not verify that engine/ stayed unchanged while the tests ran ' +
        `(${unavailableGenerationReason(after)}). If another writer touched engine/ during the run, ` +
        'this verdict is stale.'
    );
    return;
  }

  if (beforeUnavailable || afterUnavailable) {
    const detail = beforeUnavailable
      ? `engine/ could not be probed before the run (${unavailableGenerationReason(before)}) but could be ` +
        'probed afterwards, so there is no baseline to compare against.'
      : `engine/ was probed before the run but could not be probed afterwards ` +
        `(${unavailableGenerationReason(after)}), so nothing was measured to compare against.`;
    throw new InconclusiveVerdictError(
      `${detail}\n\n` +
        'This test verdict is inconclusive. Restore engine/ to a readable state, then rebuild ' +
        'and rerun the affected tests.'
    );
  }

  if (after === before) return;

  const delta = describeEngineGenerationDelta(before, after);
  throw new InconclusiveVerdictError(
    'engine/ changed while `fireforge test` was running, so this test verdict is invalid/inconclusive.\n\n' +
      (delta.length > 0 ? `What moved:\n${delta.map((line) => `  ${line}`).join('\n')}\n\n` : '') +
      'Use one writer per engine checkout, then rebuild and rerun the affected tests.'
  );
}
