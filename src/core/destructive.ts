// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared destructive-operation contract: interactive confirmation, non-TTY
 * refusal, dry-run plumbing, hard-refusal on structural conflicts, and a
 * JSONL audit log.
 *
 * This exists because the repair primitives (`patch delete`, `patch reorder`,
 * `re-export --files`) and the new `export --dry-run`/`export --order` flags
 * all share the same dance: build a change summary, gate it behind a prompt,
 * accept a `--yes` bypass for CI, accept a `--dry-run` no-op, and refuse
 * outright when the change would introduce a structural conflict (e.g. a
 * forward-import that later-patch lint would then block). Without a single
 * helper, every new destructive command would re-implement this and drift.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { confirm } from '@clack/prompts';

import { CancellationError, InvalidArgumentError } from '../errors/base.js';
import { ensureDir } from '../utils/fs.js';
import { info, isCancel, warn } from '../utils/logger.js';

/** Filename of the audit log, relative to the patches directory. */
export const HISTORY_LOG_FILENAME = '.fireforge-history.jsonl';

/**
 * A structural conflict that must block the operation even under `--force`.
 *
 * Intended for cases like "reorder would introduce a forward-import" or
 * "delete would orphan a later patch's import", situations where the
 * operator almost certainly wants a different fix (re-export --files, etc.)
 * rather than a bypass. `--force-unsafe` is the escape hatch when the
 * operator genuinely accepts the risk.
 */
export interface ConflictReport {
  /** Short one-line reason the operation is refused. */
  reason: string;
  /** Specific conflicts (patch names, file paths, lint findings). */
  details: string[];
}

/** Inputs to {@link confirmDestructive}. */
export interface DestructiveOpInput {
  /** Operation identifier, used in history entries (e.g. `patch-delete`). */
  operation: string;
  /** Short one-line title shown in the prompt. */
  title: string;
  /**
   * Detailed change summary: every affected patch, file, or renumber row.
   * Generic "proceed? [y/N]" is insufficient per the destructive-op
   * contract. Callers must list every concrete change here.
   */
  summary: string[];
  /** Whether the caller passed `--yes`. */
  yes: boolean;
  /** Whether the caller passed `--dry-run`. */
  dryRun: boolean;
  /** Whether the caller passed `--force-unsafe`. Only this flag bypasses conflicts. */
  unsafeOverride?: boolean;
  /** Structural conflicts that should block the operation unless `unsafeOverride`. */
  conflicts?: ConflictReport | null;
}

/**
 * Outcome of the destructive-operation contract.
 *
 * `'declined'` means the operator answered "no", a successful run that
 * chose not to proceed, so callers return normally and the process exits 0.
 * An interrupt (Esc / Ctrl+C) is not represented here: it throws
 * {@link CancellationError} and exits 130. Collapsing the two would make an
 * interrupted prompt indistinguishable from a declined one.
 */
export type DestructiveOpResult = 'proceed' | 'dry-run' | 'declined';

/**
 * Inputs to {@link appendHistory}. Entries are appended as one JSON record
 * per line. Callers should only append after a mutation succeeds so
 * rolled-back failures never leave ghost entries.
 */
export interface HistoryEntry {
  /** Operation identifier matching the DestructiveOpInput. */
  operation: string;
  /** Serializable argument payload (flags, targets, renumber map, etc.). */
  args: Record<string, unknown>;
  /** True if `--yes` was used. */
  yes?: boolean;
  /** True if `--force-unsafe` was used. */
  unsafeOverride?: boolean;
  /** Result: `'ok'` on success. Other strings describe failure. */
  result: string;
}

/**
 * Prints the change summary lines at warn-severity so the prompt stands out.
 */
function printSummary(title: string, summary: string[]): void {
  warn(title);
  for (const line of summary) {
    info(`  ${line}`);
  }
}

/**
 * Prints a conflict report at warn-severity. Used by both the refusal path
 * and the dry-run-with-conflicts preview path.
 */
function printConflicts(conflicts: ConflictReport): void {
  warn(`Refused: ${conflicts.reason}`);
  for (const detail of conflicts.details) {
    info(`  ${detail}`);
  }
}

/**
 * True when both standard handles are real TTYs, i.e. an interactive prompt
 * can actually be answered.
 *
 * Named for the condition rather than for confirmation specifically: many
 * call sites gate a `text()` / `multiselect()` input prompt or a mode
 * switch, not a destructive confirmation.
 *
 * Node types `isTTY` as `boolean`, but at runtime it is `true | undefined`
 * (absent when the handle is not a TTY). Unusual harnesses (vitest stdio
 * capture, CI spawners, mocked pipes) can also leave it unset on only one
 * handle, so every falsy variant (false, undefined, a null-patched mock)
 * must route to the non-interactive path.
 */
export function stdioIsInteractive(): boolean {
  const stdinIsTTY = process.stdin.isTTY as boolean | undefined;
  const stdoutIsTTY = process.stdout.isTTY as boolean | undefined;
  return stdinIsTTY === true && stdoutIsTTY === true;
}

/**
 * Up-front non-interactive refusal for a command that will end at
 * {@link confirmDestructive}.
 *
 * `confirmDestructive` already refuses a prompt-less run rather than
 * proceeding silently, but it does so at the end, after the command has
 * built diffs and run projected per-patch lint. On `patch move-files
 * --create` that is minutes of work before a scripted run learns it needed
 * `--yes`, and the failure reads as an obscure late error rather than a
 * usage problem. Calling this at command entry turns it into a usage
 * refusal that names the flag.
 *
 * A `--yes` or `--dry-run` run never prompts, so neither is refused.
 *
 * @param operation - Stable operation id, e.g. `patch-move-files-create`
 * @param options - The run's `--yes` / `--dry-run` state
 * @throws InvalidArgumentError when the run would prompt but cannot
 */
export function assertConfirmationAvailable(
  operation: string,
  options: { yes?: boolean | undefined; dryRun?: boolean | undefined }
): void {
  if (options.yes === true || options.dryRun === true) return;
  if (stdioIsInteractive()) return;
  throw new InvalidArgumentError(
    `"${operation}" ends in an interactive confirmation, but this run has no TTY to answer it ` +
      '(stdin/stdout are not both terminals). Re-run with --yes to confirm non-interactively ' +
      '(required for CI and agent-driven runs), or with --dry-run to preview without ' +
      'confirming. Refusing up front rather than after the planning and lint work.',
    '--yes'
  );
}

/**
 * Executes the destructive-operation contract: summary → conflict refusal →
 * dry-run / force / prompt / non-TTY refusal.
 *
 * Returns the decision for the caller to act on. Callers must not execute
 * the mutation when the result is `'dry-run'` or `'declined'`, and must call
 * {@link appendHistory} only after the mutation succeeds (never on dry-run
 * or decline).
 *
 * @param input - Operation description, flags, and optional conflict report
 * @returns `'proceed'` to execute, `'dry-run'` to skip execution, or
 *   `'declined'` when the user declined the prompt
 */
export async function confirmDestructive(input: DestructiveOpInput): Promise<DestructiveOpResult> {
  const { operation, title, summary, yes, dryRun, unsafeOverride, conflicts } = input;

  // Dry-run: print everything that would happen (including refusal notice if
  // the real run would be refused), but never mutate and never prompt.
  if (dryRun) {
    printSummary(`[dry-run] ${title}`, summary);
    if (conflicts) {
      printConflicts(conflicts);
      info('  The non-dry-run would be refused. Use --force-unsafe only if you accept the risk.');
    }
    return 'dry-run';
  }

  // Hard refusal: structural conflicts are only bypassable by --force-unsafe,
  // never by plain --yes. The distinction exists so that `--yes` can
  // remain a safe-for-CI bypass of interactive prompts without also being a
  // lint-override.
  if (conflicts && !unsafeOverride) {
    printConflicts(conflicts);
    throw new InvalidArgumentError(
      `Refusing to run "${operation}": ${conflicts.reason}. ` +
        'Fix the underlying issue (usually re-export --files or a different target), ' +
        'or pass --force-unsafe if you genuinely accept the risk.',
      `--force-unsafe`
    );
  }

  if (conflicts && unsafeOverride) {
    printConflicts(conflicts);
    info('  Proceeding because --force-unsafe was provided.');
  }

  // --yes bypasses confirmation but not the non-dry-run execution path.
  // Still print the summary so the operator (or CI log) has a record of what
  // happened even when no prompt was shown.
  if (yes) {
    printSummary(title, summary);
    return 'proceed';
  }

  // Non-TTY without --yes: refuse with a message pointing at --yes rather
  // than silently proceeding.
  if (!stdioIsInteractive()) {
    printSummary(title, summary);
    throw new InvalidArgumentError(
      `Interactive confirmation not available for "${operation}". ` +
        'Use --yes to run non-interactively (required for CI).',
      '--yes'
    );
  }

  // Interactive path: print the summary first so the user sees the full
  // picture, then prompt.
  printSummary(title, summary);
  const confirmed = await confirm({
    message: `${title} — proceed?`,
    initialValue: false,
  });

  // An interrupt and a "no" are different outcomes and must not share an
  // exit code. Esc / Ctrl+C is a real interrupt. 130 is 128+SIGINT and is
  // what a script needs to tell "the operator aborted" from "the operator
  // considered it and declined". Answering "no" is a successful run.
  //
  // `isCancel` narrows the clack sentinel away, leaving a plain boolean.
  if (isCancel(confirmed)) {
    throw new CancellationError();
  }

  if (!confirmed) {
    return 'declined';
  }

  return 'proceed';
}

/**
 * Appends a single JSONL record to `patches/.fireforge-history.jsonl`.
 *
 * Call order matters: append only after the mutation succeeds, never
 * pre-emptively, so rolled-back failures do not leave ghost entries. The log
 * is append-only and advisory: no code path reads it back. It exists so
 * operators have a post-hoc audit trail when something goes wrong.
 *
 * @param patchesDir - Path to the patches directory
 * @param entry - Serializable history record
 */
export async function appendHistory(patchesDir: string, entry: HistoryEntry): Promise<void> {
  await ensureDir(patchesDir);
  const record = {
    ts: new Date().toISOString(),
    ...entry,
  };
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(join(patchesDir, HISTORY_LOG_FILENAME), line, 'utf-8');
}
