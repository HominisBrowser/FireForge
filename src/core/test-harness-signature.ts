// SPDX-License-Identifier: EUPL-1.2
/**
 * The recognized-harness-crash shape, in a module of its own.
 *
 * It lives apart from both of its users to break an import cycle:
 * `test-harness-crash.ts` re-exports the operator advice in
 * `test-stall-triage.ts`, and the triage text is keyed on this signature. A
 * type-only edge is erased at runtime, but the cycle gate reads the import
 * graph rather than the emitted code, and a shared leaf is a truer
 * description of the relationship than either direction of the cycle was:
 * neither module owns this type more than the other.
 */

/** A recognized harness-crash shape with its evidence line. */
export interface HarnessCrashSignature {
  /** Stable reason id for the recognized shape. */
  reason: string;
  /** The concrete output line the recognition was based on. */
  line: string;
}
