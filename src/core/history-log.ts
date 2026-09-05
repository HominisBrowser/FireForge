// SPDX-License-Identifier: EUPL-1.2
import { toError } from '../utils/errors.js';
import { warn } from '../utils/logger.js';
import type { HistoryEntry } from './destructive.js';
import { appendHistory } from './destructive.js';

/**
 * Appends a history entry for a mutation that has ALREADY committed, degrading
 * to a warning when the log cannot be written.
 *
 * Eleven call sites across `export-flow` and the `patch` subcommands had each
 * grown the same `try { await appendHistory(...) } catch { warn(...) }` block.
 * The swallow is deliberate and load-bearing: the patch files and the manifest
 * are already on disk by the time this runs, so letting a failed log write
 * reject would report a completed, irreversible mutation as a failure and send
 * the operator looking for damage that is not there. Because that reasoning is
 * easy to lose in a copy, it now lives in one place.
 * @param patchesDir - The `patches/` directory holding the history log.
 * @param entry - The entry to append.
 * @param context - What just committed, rendered into
 *   `History log append failed after <context>: <reason>` — e.g.
 *   `patch tier committed (007-foo.patch)`.
 */
export async function appendHistoryBestEffort(
  patchesDir: string,
  entry: HistoryEntry,
  context: string
): Promise<void> {
  try {
    await appendHistory(patchesDir, entry);
  } catch (historyError: unknown) {
    warn(`History log append failed after ${context}: ${toError(historyError).message}`);
  }
}
