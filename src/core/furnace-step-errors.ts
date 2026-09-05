// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared predicates over {@link StepError} lists.
 *
 * Step errors come in two severities: blocking (the default: the apply is
 * considered failed, triggers rollback and a non-zero exit) and advisory
 * (`advisory: true`, which is reported as a warning, never blocks, and is
 * used by the `.ftl` helpers whose contract is graceful degradation). Every
 * gate that decides rollback/failure must count only blocking errors, and
 * every reporter should still surface advisory ones. This module is a leaf (types-only
 * imports) so both `furnace-apply.ts` and its callers can share the
 * predicates without import cycles.
 */

import type { StepError } from '../types/furnace.js';

/** Narrow shape shared by applied-component entries carrying step errors. */
export interface HasStepErrors {
  stepErrors?: StepError[];
}

/** Returns only the blocking (non-advisory) step errors. */
export function blockingStepErrors(stepErrors: StepError[] | undefined): StepError[] {
  return (stepErrors ?? []).filter((e) => e.advisory !== true);
}

/** True when the entry carries at least one blocking step error. */
export function hasBlockingStepErrors(entry: HasStepErrors): boolean {
  return blockingStepErrors(entry.stepErrors).length > 0;
}

/** Counts applied entries that carry at least one blocking step error. */
export function countEntriesWithBlockingStepErrors(entries: readonly HasStepErrors[]): number {
  return entries.filter((entry) => hasBlockingStepErrors(entry)).length;
}
