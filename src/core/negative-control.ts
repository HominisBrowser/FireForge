// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge test --negative-control <diff>`: apply a reviewed mutation to
 * engine sources for exactly one harness dispatch, then put every byte back.
 *
 * Safety model (also stated in docs/testing.md):
 *
 *  - The control is applied and restored only while the caller holds the
 *    engine-session lock, after the pre-test build has packaged and before
 *    the harness spawns, so no peer build or test can observe it and a
 *    Furnace deploy cannot overwrite it.
 *  - Before the first mutated byte is written, the original bytes of every
 *    target go to `.fireforge/negative-control/` together with a journal
 *    recording each file's original and mutated SHA-256, mode and
 *    timestamps. A killed FireForge therefore leaves enough on disk to undo
 *    the control, and the next `fireforge test` does so before anything else.
 *  - Restore writes the original bytes back atomically, re-applies the
 *    original mode and timestamps, and reads the file back to prove the
 *    bytes match. It only overwrites a file that still holds exactly the
 *    bytes the control wrote: anything else means someone edited the file
 *    while the control ran, and that edit is kept, never clobbered, with the
 *    original left in the journal directory and the conflict reported.
 *  - A SIGINT or SIGTERM restores through {@link restoreActiveNegativeControlsForSignal},
 *    which the entry point runs after the harness has shut down and before
 *    it releases the held locks.
 */

import { lstat, mkdir, readFile, rm, utimes } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';

import { GeneralError, PreflightRefusalError } from '../errors/base.js';
import type { FurnaceConfig } from '../types/furnace.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { writeFileAtomic } from '../utils/fs.js';
import { sha256Hex } from '../utils/hash.js';
import { notice } from '../utils/logger.js';
import {
  isContainedRelativePath,
  isPathInsideRoot,
  normalizePathSlashes,
  stripEnginePrefix,
} from '../utils/paths.js';
import { loadFurnaceConfig } from './furnace-config.js';
import { findCompiledControlTargets } from './negative-control-compiled.js';
import {
  applyControlHunks,
  type ControlDiffFile,
  parseControlDiff,
} from './negative-control-diff.js';
import type { ParsedHunk } from './patch-parse.js';
import { runInSignalCriticalSection } from './signal-critical.js';

/** Journal directory, relative to `.fireforge/`. */
const JOURNAL_DIR = 'negative-control';
const JOURNAL_FILE = 'journal.json';

/** Stable refusal class for every control preflight refusal. */
const NEGATIVE_CONTROL_NOTE = 'negative-control';

/** One file a control mutates. */
export interface NegativeControlTarget {
  /** The path as the diff names it. */
  diffPath: string;
  /** The engine-relative file the control mutates. */
  enginePath: string;
  /** Hunks to apply to the engine file. */
  hunks: ParsedHunk[];
  /** True when the diff named a `components/` source mapped to its deployed copy. */
  fromComponents: boolean;
}

/** A parsed, resolved control, ready to apply. */
export interface NegativeControlPlan {
  /** The diff file, as the operator passed it. */
  diffFile: string;
  targets: NegativeControlTarget[];
  /**
   * Engine-relative targets only a build delivers (compiled sources). A
   * control with any must be applied before the pre-test build, and is
   * restored with a fresh mtime. See `negative-control-compiled.ts`.
   */
  compiled?: string[];
}

/** Locations a control works against. */
export interface NegativeControlPaths {
  engineDir: string;
  /** The project's `.fireforge/` directory. */
  fireforgeDir: string;
}

interface JournalEntry {
  enginePath: string;
  backup: string;
  originalSha256: string;
  mutatedSha256: string;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  /**
   * Restore with the current time as mtime, not the original: a compiled
   * source restored with its old mtime is skipped by the incremental build,
   * which would leave the mutated code in the binary.
   */
  freshMtime?: boolean;
}

interface Journal {
  version: 1;
  diffFile: string;
  appliedAt: string;
  entries: JournalEntry[];
}

/** A control currently applied to the engine. */
export interface ActiveNegativeControl {
  paths: NegativeControlPaths;
  journal: Journal;
  /**
   * The one restore in flight, set synchronously by whichever path (the
   * run's own `finally`, or the signal handler) gets there first, so the
   * other awaits the same restore instead of racing or skipping it.
   */
  restoring?: Promise<NegativeControlRestoreResult>;
}

const active = new Set<ActiveNegativeControl>();

function refuse(message: string): never {
  throw new PreflightRefusalError(message, NEGATIVE_CONTROL_NOTE);
}

function journalDir(paths: NegativeControlPaths): string {
  return join(paths.fireforgeDir, JOURNAL_DIR);
}

/**
 * Maps a `components/custom/<name>/<file>` or
 * `components/overrides/<name>/<file>` path onto the engine file Furnace
 * deploys it to. The run reads the deployed copy, so that is what the
 * control has to mutate.
 */
function mapComponentPath(diffPath: string, config: FurnaceConfig): string {
  const [, kind, name, ...rest] = diffPath.split('/');
  const file = rest.join('/');
  if (kind === 'custom' && name !== undefined && rest.length === 1) {
    const component = config.custom[name];
    if (component && (file.endsWith('.mjs') || file.endsWith('.css'))) {
      return posix.join(normalizePathSlashes(component.targetPath), file);
    }
  }
  if (kind === 'overrides' && name !== undefined && rest.length === 1) {
    const override = config.overrides[name];
    if (override && !file.endsWith('.ftl')) {
      return posix.join(normalizePathSlashes(override.basePath), file);
    }
  }
  return refuse(
    `${diffPath} does not map to one deployed engine file (supported: a custom component's ` +
      '.mjs/.css, or an override file other than .ftl, of a component furnace.json declares). ' +
      'Write the control against the deployed engine file instead.'
  );
}

async function resolveTargets(
  projectRoot: string,
  files: readonly ControlDiffFile[]
): Promise<NegativeControlTarget[]> {
  let furnaceConfig: FurnaceConfig | undefined;
  const targets: NegativeControlTarget[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const fromComponents = file.path.startsWith('components/');
    let enginePath: string;
    if (fromComponents) {
      furnaceConfig ??= await loadFurnaceConfig(projectRoot);
      enginePath = mapComponentPath(file.path, furnaceConfig);
    } else {
      enginePath = stripEnginePrefix(file.path);
    }
    if (seen.has(enginePath)) refuse(`two diff sections resolve to engine/${enginePath}.`);
    seen.add(enginePath);
    targets.push({ diffPath: file.path, enginePath, hunks: file.hunks, fromComponents });
  }
  return targets;
}

interface PreparedTarget {
  target: NegativeControlTarget;
  absolutePath: string;
  original: Buffer;
  mutated: Buffer;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

async function prepareTarget(
  engineDir: string,
  target: NegativeControlTarget
): Promise<PreparedTarget> {
  const absolutePath = join(engineDir, target.enginePath);
  const label = `engine/${target.enginePath}`;
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') refuse(`${label} does not exist.`);
    throw error;
  }
  if (!stats.isFile()) {
    refuse(
      `${label} is not a regular file (a symlink or directory cannot be restored byte-exact).`
    );
  }
  const original = await readFile(absolutePath);
  const text = original.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(original)) refuse(`${label} is not valid UTF-8 text.`);
  let mutatedText: string;
  try {
    mutatedText = applyControlHunks(text, target.hunks, label);
  } catch (error: unknown) {
    refuse(toError(error).message);
  }
  if (mutatedText === text) refuse(`the diff leaves ${label} unchanged.`);
  return {
    target,
    absolutePath,
    original,
    mutated: Buffer.from(mutatedText, 'utf8'),
    mode: stats.mode,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
  };
}

/**
 * Reads, parses and resolves a control diff, and (unless `deferApplyCheck`)
 * proves every hunk applies to the current engine file, so a broken control
 * is refused before any build time is spent.
 *
 * `deferApplyCheck` is for a run that builds first: Furnace redeploys a
 * component's engine copy during the build, so a `components/` control can
 * only be checked against what the build left behind.
 *
 * @param projectRoot - Project root; the diff path resolves against it
 * @param engineDir - Absolute engine directory
 * @param diffFile - The `--negative-control` argument
 * @param options - `deferApplyCheck` skips the up-front apply check for
 *   `components/` targets
 */
export async function planNegativeControl(
  projectRoot: string,
  engineDir: string,
  diffFile: string,
  options: { deferApplyCheck?: boolean } = {}
): Promise<NegativeControlPlan> {
  let content: string;
  try {
    content = await readFile(resolve(projectRoot, diffFile), 'utf8');
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') {
      refuse(`Negative control diff not found: ${diffFile} (resolved against the project root).`);
    }
    throw error;
  }
  let files: ControlDiffFile[];
  try {
    files = parseControlDiff(content, {
      resolveRename: (source, target) => resolveEditedCopyRename(projectRoot, source, target),
    });
  } catch (error: unknown) {
    refuse(toError(error).message);
  }
  const targets = await resolveTargets(projectRoot, files);
  for (const target of targets) {
    if (options.deferApplyCheck === true && target.fromComponents) continue;
    await prepareTarget(engineDir, target);
  }
  const compiled = await findCompiledControlTargets(
    engineDir,
    targets.filter((target) => !target.fromComponents).map((target) => target.enginePath)
  );
  return { diffFile, targets, ...(compiled.length > 0 ? { compiled } : {}) };
}

/**
 * A diff path as a project-relative path: a contained relative path as
 * is, and an absolute one (git strips the leading `/` into `a/Users/…`)
 * when it lies inside the project. Undefined otherwise.
 */
function projectRelative(projectRoot: string, path: string): string | undefined {
  const normalized = normalizePathSlashes(path);
  for (const candidate of [`/${normalized}`, normalized]) {
    if (!isAbsolute(candidate)) continue;
    if (isPathInsideRoot(projectRoot, candidate)) {
      return normalizePathSlashes(relative(projectRoot, candidate));
    }
  }
  return isContainedRelativePath(normalized) ? normalized : undefined;
}

/**
 * The control target of a `git diff --no-index <engine file> <edited copy>`
 * section: its old side, when that names a project file and the new side
 * names a copy outside `engine/` and `components/`. A section whose sides
 * both live in those trees is a real rename and stays refused.
 */
function resolveEditedCopyRename(
  projectRoot: string,
  source: string,
  target: string
): string | undefined {
  const old = projectRelative(projectRoot, source);
  if (old === undefined) return undefined;
  const edited = projectRelative(projectRoot, target);
  const tracked = (path: string): boolean =>
    path.startsWith('engine/') || path.startsWith('components/');
  if (edited !== undefined && tracked(edited)) return undefined;
  return old;
}

async function writeJournal(paths: NegativeControlPaths, journal: Journal): Promise<void> {
  await writeFileAtomic(
    join(journalDir(paths), JOURNAL_FILE),
    `${JSON.stringify(journal, null, 2)}\n`
  );
}

/**
 * Applies the control: every target is computed first (a hunk that does
 * not apply refuses with nothing written), the originals and the journal
 * are persisted, then the mutated bytes are written. Runs as a signal
 * critical section, so a Ctrl+C mid-apply waits for the apply to finish
 * and the signal path then restores a complete journal.
 *
 * @returns The handle {@link restoreNegativeControl} takes
 */
export async function applyNegativeControl(
  paths: NegativeControlPaths,
  plan: NegativeControlPlan
): Promise<ActiveNegativeControl> {
  const prepared: PreparedTarget[] = [];
  for (const target of plan.targets) prepared.push(await prepareTarget(paths.engineDir, target));
  return runInSignalCriticalSection('negative-control-apply', async () => {
    const dir = journalDir(paths);
    await mkdir(dir, { recursive: true });
    const entries: JournalEntry[] = [];
    for (const [index, item] of prepared.entries()) {
      const backup = `${index}.orig`;
      await writeFileAtomic(join(dir, backup), item.original);
      entries.push({
        enginePath: item.target.enginePath,
        backup,
        originalSha256: sha256Hex(item.original),
        mutatedSha256: sha256Hex(item.mutated),
        mode: item.mode,
        atimeMs: item.atimeMs,
        mtimeMs: item.mtimeMs,
        ...(plan.compiled?.includes(item.target.enginePath) === true ? { freshMtime: true } : {}),
      });
    }
    const journal: Journal = {
      version: 1,
      diffFile: plan.diffFile,
      appliedAt: new Date().toISOString(),
      entries,
    };
    await writeJournal(paths, journal);
    const control: ActiveNegativeControl = { paths, journal };
    active.add(control);
    try {
      for (const item of prepared) await writeFileAtomic(item.absolutePath, item.mutated);
    } catch (error: unknown) {
      // A half-applied control never reaches a harness: put back whatever
      // was written (untouched files read as already restored), then fail.
      await restoreNegativeControl(control);
      throw error;
    }
    return control;
  });
}

/** What happened to each file of a restored control. */
export interface NegativeControlRestoreResult {
  /** Engine-relative files put back to their original bytes. */
  restored: string[];
  /** Engine-relative files that held neither the control's bytes nor the original. */
  conflicts: string[];
}

async function restoreEntry(
  paths: NegativeControlPaths,
  entry: JournalEntry
): Promise<'restored' | 'conflict'> {
  const absolutePath = join(paths.engineDir, entry.enginePath);
  let current: Buffer | undefined;
  try {
    current = await readFile(absolutePath);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  const currentSha = current === undefined ? undefined : sha256Hex(current);
  if (currentSha === entry.originalSha256) return 'restored';
  if (currentSha !== entry.mutatedSha256) return 'conflict';
  const original = await readFile(join(journalDir(paths), entry.backup));
  if (sha256Hex(original) !== entry.originalSha256) {
    throw new GeneralError(
      `Negative control backup for engine/${entry.enginePath} does not match its journal; ` +
        `left the file as is. Inspect ${journalDir(paths)}.`
    );
  }
  await writeFileAtomic(absolutePath, original);
  if (entry.freshMtime === true) {
    const now = Date.now() / 1000;
    await utimes(absolutePath, now, now);
  } else {
    await utimes(absolutePath, entry.atimeMs / 1000, entry.mtimeMs / 1000);
  }
  const readBack = await readFile(absolutePath);
  const stats = await lstat(absolutePath);
  if (!readBack.equals(original) || (stats.mode & 0o7777) !== (entry.mode & 0o7777)) {
    throw new GeneralError(
      `Restoring engine/${entry.enginePath} did not read back byte-exact; ` +
        `the original is kept in ${journalDir(paths)}.`
    );
  }
  return 'restored';
}

async function restoreJournal(
  paths: NegativeControlPaths,
  journal: Journal
): Promise<NegativeControlRestoreResult> {
  const result: NegativeControlRestoreResult = { restored: [], conflicts: [] };
  for (const entry of journal.entries) {
    const outcome = await restoreEntry(paths, entry);
    (outcome === 'restored' ? result.restored : result.conflicts).push(entry.enginePath);
  }
  if (result.conflicts.length === 0) {
    await rm(journalDir(paths), { recursive: true, force: true });
  }
  return result;
}

function conflictMessage(paths: NegativeControlPaths, conflicts: readonly string[]): string {
  return (
    `Negative control restore left ${conflicts.length} file(s) alone because they changed while ` +
    `the control was applied: ${conflicts.map((path) => `engine/${path}`).join(', ')}. ` +
    `Their pre-control bytes are kept in ${journalDir(paths)} (see journal.json for which ` +
    'backup belongs to which file). Reconcile by hand, then delete that directory.'
  );
}

/**
 * Restores a control applied by {@link applyNegativeControl}. Idempotent:
 * a second caller (the signal handler racing the run's own `finally`)
 * receives the restore already in flight.
 *
 * @throws GeneralError when a file changed under the control (the edit is
 *   kept and the original stays in the journal directory) or did not read
 *   back byte-exact
 */
export function restoreNegativeControl(
  control: ActiveNegativeControl
): Promise<NegativeControlRestoreResult> {
  control.restoring ??= (async (): Promise<NegativeControlRestoreResult> => {
    try {
      return await runInSignalCriticalSection('negative-control-restore', async () => {
        const result = await restoreJournal(control.paths, control.journal);
        if (result.conflicts.length > 0) {
          throw new GeneralError(conflictMessage(control.paths, result.conflicts));
        }
        return result;
      });
    } finally {
      active.delete(control);
    }
  })();
  return control.restoring;
}

/**
 * Restores every applied control on the way out of a SIGINT/SIGTERM. Called
 * by the entry point after child shutdown and before the held locks are
 * force-released. Never throws: a failure is reported on stderr and the
 * journal stays for the next run's recovery.
 */
export async function restoreActiveNegativeControlsForSignal(): Promise<void> {
  for (const control of [...active]) {
    try {
      await restoreNegativeControl(control);
    } catch (error: unknown) {
      console.error(`Negative control restore after signal failed: ${toError(error).message}`);
    }
  }
}

/**
 * Undoes a control a killed FireForge left applied. Called at the start of
 * every `fireforge test`, under the engine-session lock. A file that still
 * holds the control's bytes is restored; a file somebody changed since is
 * refused rather than overwritten.
 *
 * @throws PreflightRefusalError (`note=negative-control-pending`) when a
 *   journal entry cannot be restored safely
 */
export async function recoverPendingNegativeControl(paths: NegativeControlPaths): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(journalDir(paths), JOURNAL_FILE), 'utf8');
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return;
    throw error;
  }
  let journal: Journal;
  try {
    const parsed = JSON.parse(raw) as Partial<Journal> | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('bad shape');
    journal = parsed as Journal;
  } catch {
    throw new PreflightRefusalError(
      `The negative control journal ${join(journalDir(paths), JOURNAL_FILE)} is unreadable. ` +
        'Restore its backups by hand, then delete that directory.',
      'negative-control-pending'
    );
  }
  const result = await restoreJournal(paths, journal);
  if (result.conflicts.length > 0) {
    throw new PreflightRefusalError(
      `A negative control (${journal.diffFile}, applied ${journal.appliedAt}) was left applied by an interrupted run. ` +
        conflictMessage(paths, result.conflicts),
      'negative-control-pending'
    );
  }
  notice(
    `Restored ${result.restored.length} file(s) a negative control (${journal.diffFile}) left applied ` +
      'when its run was killed.'
  );
}
