// SPDX-License-Identifier: EUPL-1.2
import type { ProofPlan } from './types.js';

/** The part of an evidence row carrying needs: which step it proves, and when. */
interface CarriedRow {
  fingerprint: string;
  at: string;
}

/**
 * This source's evidence with the carried source's rows for what the plan carries,
 * each marked as carried. The newest result still decides, so a red here after a
 * carried pass is a red.
 */
export function withCarried<R extends CarriedRow, S extends { rows: R[] }>(
  plan: ProofPlan,
  store: S,
  carried: { store: { rows: readonly R[] } } | undefined
): S {
  if (plan.carry === undefined || carried === undefined) return store;
  const prints = new Set(
    plan.obligations.flatMap((obligation) =>
      obligation.carried === true ? obligation.fingerprints : []
    )
  );
  const rows = carried.store.rows
    .filter((row) => prints.has(row.fingerprint))
    .map((row) => ({ ...row, carried: true as const }));
  return { ...store, rows: [...store.rows, ...rows].sort((a, b) => a.at.localeCompare(b.at)) };
}
