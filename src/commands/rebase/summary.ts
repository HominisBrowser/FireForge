// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase summary and status label formatting.
 */

import type { RebasePatchEntry, RebaseSession } from '../../core/rebase-session.js';
import { info } from '../../utils/logger.js';

/**
 * Formats a status label for a rebase patch entry.
 */
function statusLabel(status: RebasePatchEntry['status'], fuzzFactor?: number): string {
  switch (status) {
    case 'applied-clean':
      return 'applied cleanly';
    case 'applied-fuzz':
      return `applied with context reduction (step ${fuzzFactor ?? '?'})`;
    case 'resolved':
      return 'RESOLVED manually';
    case 'failed':
      return 'FAILED';
    case 'skipped':
      return 'skipped';
    case 'pending':
      return 'pending';
  }
}

/**
 * Prints the rebase summary table.
 */
export function printSummary(session: RebaseSession): void {
  info('');
  const from = session.fromProduct
    ? `${session.fromProduct} ${session.fromVersion}`
    : session.fromVersion;
  const to = session.toProduct ? `${session.toProduct} ${session.toVersion}` : session.toVersion;
  info(`Source Rebase Summary: ${from} → ${to}`);
  info('='.repeat(55));

  for (const patch of session.patches) {
    const label = statusLabel(patch.status, patch.fuzzFactor);
    info(
      `  ${patch.filename} ${'·'.repeat(Math.max(1, 45 - patch.filename.length - label.length))} ${label}`
    );
  }

  const clean = session.patches.filter((p) => p.status === 'applied-clean').length;
  const fuzz = session.patches.filter((p) => p.status === 'applied-fuzz').length;
  const resolved = session.patches.filter((p) => p.status === 'resolved').length;
  const failed = session.patches.filter((p) => p.status === 'failed').length;
  const total = session.patches.length;

  info('');
  info(
    `Results: ${total} total: ${clean} clean, ${fuzz} context-reduced, ${resolved} manually resolved, ${failed} failed`
  );
}
