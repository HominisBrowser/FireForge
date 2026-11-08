// SPDX-License-Identifier: EUPL-1.2
/**
 * One measurement of the engine's working tree per engine-session lock hold.
 *
 * A `git status` over a patched Firefox checkout walks every tracked file, so
 * every question a `fireforge test` asks about engine state reads the same
 * inventory: the changed-path census behind the stale gates, the dirty-file
 * set behind baseline fingerprints and coverage anchors, and the generation
 * token behind the engine guard. Inside {@link withEngineStateHold} the
 * inventory is taken once and kept until this process writes to the engine
 * (`invalidateEngineState`) or a harness has run (`refreshEngineGeneration`).
 *
 * A kept inventory never hides an edit, because the guard compares against it:
 * tokens chain from the first gate to the last dispatch, so a peer's edit
 * landing anywhere after the first measurement is in the next "after" token and
 * is judged there. Reads outside a hold measure afresh every time.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { InconclusiveVerdictError } from '../errors/base.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import { warn } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import {
  CONTENT_SEPARATOR,
  describeEngineGenerationDelta,
  isIndexLockError,
  isUnavailableGenerationToken,
  UNAVAILABLE_PREFIX,
  unavailableGenerationReason,
} from './engine-session-lock.js';
import type { GitStatusEntry } from './git-base.js';
import { git } from './git-base.js';
import { parsePorcelainStatus } from './git-status.js';
import { trustedSlotBuild } from './jobs/guard.js';

/** The working-tree walk every inventory is built from. */
const ENGINE_STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];

/** One `git status` of the engine. */
export interface EngineInventory {
  /** Raw porcelain output, the working-tree half of a generation token. */
  status: string;
  entries: readonly GitStatusEntry[];
  /** Every dirty engine-relative path, tracked and untracked, both sides of a rename. */
  paths: readonly string[];
}

interface EngineMeasurement {
  inventory?: Promise<EngineInventory>;
  generation?: Promise<string>;
  /** Commit-to-commit diffs by anchor; a commit moves HEAD, which only a write does here. */
  headDiffs: Map<string, Promise<readonly string[]>>;
}

interface EngineStateHold {
  measurements: Map<string, EngineMeasurement>;
  /** Engines whose packaged content this hold already judged against the tree. */
  judged: Set<string>;
}

const holds = new AsyncLocalStorage<EngineStateHold>();

/**
 * Shares one engine measurement across everything `operation` reads. Nested
 * calls join the enclosing hold.
 */
export function withEngineStateHold<T>(operation: () => Promise<T>): Promise<T> {
  if (holds.getStore() !== undefined) return operation();
  return holds.run({ measurements: new Map(), judged: new Set() }, operation);
}

async function walkEngine(engineDir: string): Promise<EngineInventory> {
  const status = await git(ENGINE_STATUS_ARGS, engineDir);
  const entries = parsePorcelainStatus(status);
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.file);
    if (entry.originalPath !== undefined) paths.add(entry.originalPath);
  }
  return { status, entries, paths: [...paths].sort() };
}

function measurementFor(engineDir: string): EngineMeasurement {
  const hold = holds.getStore();
  const kept = hold?.measurements.get(engineDir);
  if (kept !== undefined) return kept;
  const measurement: EngineMeasurement = { headDiffs: new Map() };
  hold?.measurements.set(engineDir, measurement);
  return measurement;
}

/** The measurement's walk, started on first use. A failed walk is not remembered. */
function walkOf(engineDir: string, measurement: EngineMeasurement): Promise<EngineInventory> {
  if (measurement.inventory !== undefined) return measurement.inventory;
  const walk = walkEngine(engineDir);
  measurement.inventory = walk;
  walk.catch(() => {
    if (measurement.inventory === walk) delete measurement.inventory;
  });
  return walk;
}

/**
 * The engine's inventory: the hold's, or a fresh one outside a hold. Rejects on
 * a git failure, which every safety decision treats as "cannot prove clean".
 *
 * @param engineDir - Absolute engine directory
 */
export function readEngineInventory(engineDir: string): Promise<EngineInventory> {
  return walkOf(engineDir, measurementFor(engineDir));
}

/**
 * Engine-relative paths changed between `anchor` and HEAD. Reads no working
 * tree, so it costs no walk.
 *
 * @param engineDir - Absolute engine directory
 * @param anchor - Commit to diff from
 */
export function readCommittedChanges(
  engineDir: string,
  anchor: string
): Promise<readonly string[]> {
  const { headDiffs } = measurementFor(engineDir);
  let pending = headDiffs.get(anchor);
  if (pending === undefined) {
    pending = git(['diff', '--name-only', '--no-renames', '-z', `${anchor}..HEAD`], engineDir).then(
      (output) => output.split('\0').filter((path) => path.length > 0)
    );
    headDiffs.set(anchor, pending);
  }
  return pending;
}

/**
 * Forgets the hold's measurement after this process wrote to the engine (a
 * Furnace apply, a negative control, a build), so the next reader sees the
 * write. The tree changed under the hold's own hands, so what it judged earlier
 * no longer stands either.
 *
 * @param engineDir - Absolute engine directory
 */
export function invalidateEngineState(engineDir: string): void {
  const hold = holds.getStore();
  hold?.measurements.delete(engineDir);
  hold?.judged.delete(engineDir);
}

/**
 * Whether this hold already judged the packaged runtime's content against the
 * tree. Later sub-runs of the hold test the same packaged runtime, so that
 * verdict still stands for them, and the chained generation guard judges
 * anything that lands afterwards.
 *
 * @param engineDir - Absolute engine directory
 */
export function isEngineContentJudged(engineDir: string): boolean {
  return holds.getStore()?.judged.has(engineDir) === true;
}

/**
 * Records that a gate judged the packaged content. See
 * {@link isEngineContentJudged}.
 *
 * @param engineDir - Absolute engine directory
 */
export function markEngineContentJudged(engineDir: string): void {
  holds.getStore()?.judged.add(engineDir);
}

/** Files hashed at once: the dirty set of a patched checkout runs to thousands. */
const IDENTITY_CONCURRENCY = 16;
/** Probe attempts before an engine generation is declared unmeasurable. */
const GENERATION_PROBE_ATTEMPTS = 3;
/** Pause between generation-probe attempts. */
const GENERATION_PROBE_RETRY_MS = 250;

/** The probe's answer for a tree with no repository or no commit to compare against. */
const NOT_A_MEASURABLE_CHECKOUT =
  /not a git repository|unknown revision or path not in the working tree|spawn \S*git ENOENT/i;

/** A dirty file or HEAD moved under one capture; the next attempt measures again. */
class EngineCaptureRaceError extends Error {}

async function dirtyFileIdentity(engineDir: string, path: string): Promise<string> {
  const absolute = join(engineDir, path);
  try {
    const before = await lstat(absolute);
    // `git status` reports an untracked nested repository as a directory, and
    // a FIFO or socket has no bytes to read: their mode is all there is to hold.
    if (before.isDirectory()) return `dir:${before.mode & 0o777}`;
    const kind = before.isSymbolicLink() ? 'symlink' : before.isFile() ? 'file' : 'other';
    if (kind === 'other') return `other:${before.mode & 0o777}`;
    const bytes =
      kind === 'symlink' ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    const after = await lstat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new EngineCaptureRaceError(`${path} changed while the generation was captured`);
    }
    return `${kind}:${before.mode & 0o777}:${sha256Hex(bytes)}`;
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    return 'deleted';
  }
}

async function captureGeneration(
  engineDir: string,
  measurement: EngineMeasurement
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < GENERATION_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const head = (await git(['rev-parse', 'HEAD'], engineDir)).trim();
      if (attempt > 0) delete measurement.inventory;
      const { status, paths } = await walkOf(engineDir, measurement);
      const hashed = await mapWithConcurrency(paths, IDENTITY_CONCURRENCY, async (path) => {
        return [path, await dirtyFileIdentity(engineDir, path)] as const;
      });
      if ((await git(['rev-parse', 'HEAD'], engineDir)).trim() !== head) {
        throw new EngineCaptureRaceError('HEAD moved while the generation was captured');
      }
      const contents = JSON.stringify(Object.fromEntries(hashed));
      return `${head}\0${status}${CONTENT_SEPARATOR}${contents}`;
    } catch (error: unknown) {
      lastError = error;
      // A contended `.git/index.lock` or a peer saving a dirty file is a
      // moment, not a state. Anything else (an unreadable `.git`, a non-git
      // `engine/`) is a real state and is reported immediately.
      const transient = error instanceof EngineCaptureRaceError || isIndexLockError(error);
      if (!transient || attempt === GENERATION_PROBE_ATTEMPTS - 1) break;
      await sleep(GENERATION_PROBE_RETRY_MS);
    }
  }
  return `${UNAVAILABLE_PREFIX}${toError(lastError).message}`;
}

/**
 * The engine's generation token: the hold's measurement, hashed once. Never
 * rejects: a failed probe yields a token {@link isUnavailableGenerationToken}
 * recognizes, because a probe failure means "nothing was measured", not
 * "nothing changed". A trusted slot's token is its recorded identity.
 *
 * @param engineDir - Absolute engine directory
 */
export async function captureEngineGeneration(engineDir: string): Promise<string> {
  const trusted = await trustedSlotBuild(dirname(engineDir));
  if (trusted !== undefined)
    return `slot:${trusted.sourceId}:${trusted.slotGeneration}:${trusted.successfulBuildGeneration}:${trusted.baselineDigest}:${trusted.materializationDigest}`;
  const measurement = measurementFor(engineDir);
  measurement.generation ??= captureGeneration(engineDir, measurement);
  return measurement.generation;
}

/**
 * Measures again after a harness ran, and keeps the measurement: this "after"
 * token is the next sub-run's "before", and its inventory serves the next gate.
 *
 * @param engineDir - Absolute engine directory
 */
export function refreshEngineGeneration(engineDir: string): Promise<string> {
  const hold = holds.getStore();
  hold?.measurements.delete(engineDir);
  return captureEngineGeneration(engineDir);
}

/**
 * Throws when `after` differs from `before`, i.e. the engine was mutated while
 * a test run was in flight.
 *
 * Only an `engine/` that is not a git checkout with a commit warns rather than
 * throws (`fireforge download` extracts a source tarball). Any other failed
 * probe, on either side, leaves nothing to compare, so the verdict cannot stand.
 * Tokens are never compared for equality when a probe failed, since two failures
 * would otherwise bless a run the guard never verified.
 *
 * @param before - Token captured before the run
 * @param after - Token captured after the run
 * @param tolerateDelta - Proves a delta never reached the runtime under test
 */
export async function judgeEngineGeneration(
  before: string,
  after: string,
  tolerateDelta?: (before: string, after: string) => Promise<boolean>
): Promise<void> {
  const beforeUnavailable = isUnavailableGenerationToken(before);
  const afterUnavailable = isUnavailableGenerationToken(after);
  if (
    beforeUnavailable &&
    afterUnavailable &&
    NOT_A_MEASURABLE_CHECKOUT.test(unavailableGenerationReason(before)) &&
    NOT_A_MEASURABLE_CHECKOUT.test(unavailableGenerationReason(after))
  ) {
    warn(
      'Could not verify that engine/ stayed unchanged while the tests ran ' +
        `(${unavailableGenerationReason(after)}). If another writer touched engine/ during the run, ` +
        'this verdict is stale.'
    );
    return;
  }
  if (beforeUnavailable && afterUnavailable) {
    throw new InconclusiveVerdictError(
      `engine/ could not be measured around the run (${unavailableGenerationReason(after)}), so ` +
        'nothing was compared.\n\nThis test verdict is inconclusive. Restore engine/ to a readable ' +
        'state, then rebuild and rerun the affected tests.'
    );
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
  // A caller that can prove the delta never reached the runtime under test
  // keeps its verdict.
  if (tolerateDelta !== undefined && (await tolerateDelta(before, after))) return;
  const delta = describeEngineGenerationDelta(before, after);
  throw new InconclusiveVerdictError(
    'engine/ changed while `fireforge test` was running, so this test verdict is invalid/inconclusive.\n\n' +
      (delta.length > 0 ? `What moved:\n${delta.map((line) => `  ${line}`).join('\n')}\n\n` : '') +
      'Use one writer per engine checkout, then rebuild and rerun the affected tests.'
  );
}
