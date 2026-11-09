// SPDX-License-Identifier: EUPL-1.2
import { exec } from './process.js';
import {
  parseProcessListing,
  type ProcessColumn,
  type ProcessRow,
  PS_BINARY,
  PS_ENV,
  psArguments,
} from './process-listing.js';

/** Options for {@link listProcessText}. */
export interface ListProcessesOptions {
  /** Limit the listing to these pids. A pid that is gone produces no row. */
  pids?: readonly number[];
  timeoutMs?: number;
  /** Append each process's environment to a command column, as far as the platform shows it. */
  includeEnvironment?: boolean;
  /** Treat a non-zero exit as failure even for a listing limited to `pids`. */
  requireCleanExit?: boolean;
}

/**
 * Runs a process listing and returns the raw text, for a parser that fixtures
 * also feed directly.
 *
 * @param columns - Columns in output order; a rest-of-line column must be last
 * @param options - See {@link ListProcessesOptions}
 * @throws When `ps` cannot run, or when an unrestricted listing exits non-zero.
 *   `ps -p` exits 1 when any listed pid is gone while still printing the rest,
 *   so a restricted listing does not treat the exit code as failure unless
 *   `requireCleanExit` says so.
 */
export async function listProcessText(
  columns: readonly ProcessColumn[],
  options: ListProcessesOptions = {}
): Promise<string> {
  if (options.pids?.length === 0) return '';
  const args = psArguments(columns, options.pids, options.includeEnvironment === true);
  const result = await exec(PS_BINARY, [...args], {
    env: { ...PS_ENV },
    timeout: options.timeoutMs ?? 10_000,
  });
  if ((options.pids === undefined || options.requireCleanExit === true) && result.exitCode !== 0) {
    throw new Error(`ps exited ${result.exitCode}`);
  }
  return result.stdout;
}

/**
 * Lists processes with the requested columns, for diagnostics and preflights.
 *
 * @param columns - Columns in output order; a rest-of-line column must be last
 * @param options - See {@link ListProcessesOptions}
 * @throws Like {@link listProcessText}
 */
export async function listProcesses<C extends ProcessColumn>(
  columns: readonly C[],
  options: ListProcessesOptions = {}
): Promise<ProcessRow<C>[]> {
  return parseProcessListing(await listProcessText(columns, options), columns);
}
