// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { info, warn } from '../utils/logger.js';
import type { LockHolder } from './file-lock.js';
import { withFileLock } from './file-lock.js';
import { git } from './git-base.js';

const ENGINE_SESSION_LOCK_PATH = join('.fireforge', 'engine-session.lock');

export interface EngineSessionLockOptions {
  /**
   * Wait up to this many seconds for the engine session lock instead of the
   * legacy ~1 s fail-fast. Enables exponential poll backoff (100 ms → 2 s)
   * and a holder-identified progress line roughly every 5 s. `undefined`
   * preserves the historical fail-fast behavior exactly.
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
  holder: LockHolder | undefined
): string {
  const progress = `${String(Math.round(waitedMs / 1000))}s of up to ${String(Math.round(timeoutMs / 1000))}s`;
  if (holder === undefined) {
    return `Waiting for the FireForge engine lock — ${progress}.`;
  }
  const details = holder.metadata.length > 0 ? ` (${holder.metadata.join(', ')})` : '';
  return `Waiting for the FireForge engine lock held by PID ${String(holder.pid)}${details} — ${progress}.`;
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
  // `FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST=1` is what lets the lock's
  // own tests opt back in. Do not delete this branch — it is the reason the
  // suite completes, not an oversight.
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
          onWaitProgress: ({ waitedMs, timeoutMs, holder }): void => {
            info(formatWaitProgressLine(waitedMs, timeoutMs, holder));
          },
        }
      : {}),
    ownerMetadata: [`command=${command}`, `started=${new Date().toISOString()}`],
    // Reason first, remedy second (FORGE H5) — the no-flag default waits
    // only ~1 s, so contention is the common case and `--wait-lock` is the
    // genuine remedy. withFileLock appends the holder identification from
    // the lock's owner metadata. The leading sentence is a message contract
    // (pinned by engine-session-lock tests); extend, don't reword.
    onTimeoutMessage:
      `Another FireForge engine-mutating command is already running. ` +
      `Wait for it to finish, then retry \`${command}\` — or pass --wait-lock [seconds] ` +
      `to wait for the lock (bare --wait-lock waits up to 60 seconds).`,
    onStaleLockMessage: (ageMs) =>
      `Removed stale FireForge engine session lock (${Math.round(ageMs / 1000)}s old).`,
  });
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
  try {
    const head = (await git(['rev-parse', 'HEAD'], engineDir)).trim();
    const status = await git(['status', '--porcelain=v1', '-z'], engineDir);
    return `${head}\0${status}`;
  } catch (error: unknown) {
    return `${UNAVAILABLE_PREFIX}${toError(error).message}`;
  }
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

/**
 * Throws when the engine's generation token differs from `before`, i.e. the
 * engine was mutated by another writer while a test run was in flight.
 *
 * **An unmeasurable engine warns rather than throws.** `engine/` is not always
 * a git checkout — `fireforge download` extracts a source tarball — so a
 * failed probe is a legitimate state and must not fail the run.
 *
 * What it must also not do is pass *silently*. Before 0.41.0 the failure token
 * was `unavailable:<message>` and was compared for equality like any other, so
 * a git failure that reproduced across both probes (unreadable `.git`, a
 * permissions problem, a corrupt index) produced identical tokens, took the
 * `after === before` early return, and blessed a verdict the guard had never
 * verified — the precise outcome this guard exists to prevent. Two *differing*
 * failure messages were worse still: they fell through to the mutation branch
 * and reported a spurious "engine/ changed".
 *
 * The tolerance is deliberately limited to a probe that failed *both* times:
 * that is the steady state of a non-git `engine/`, and it warns. A one-sided
 * transition is not that state. `engine/` that was measurable and then was not
 * means the second probe measured nothing about a checkout that demonstrably
 * had something to measure; the reverse means there was never a baseline to
 * compare against. Neither is a run whose verdict can be trusted, so both
 * throw. Compare on the prefix rather than the token, because the token embeds
 * the error message and two genuine failures rarely phrase it identically.
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
    throw new GeneralError(
      `${detail}\n\n` +
        'This test verdict is inconclusive. Restore engine/ to a readable state, then rebuild ' +
        'and rerun the affected tests.'
    );
  }

  if (after === before) return;

  throw new GeneralError(
    'engine/ changed while `fireforge test` was running, so this test verdict is invalid/inconclusive.\n\n' +
      'Use one writer per engine checkout, then rebuild and rerun the affected tests.'
  );
}
