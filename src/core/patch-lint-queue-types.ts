// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural views of the cross-patch lint queue context.
 *
 * A leaf module by design: it imports nothing, so the individual rule
 * modules can describe the slice of `PatchQueueContext` they read without
 * importing `patch-lint-cross.ts` (which imports them back). Previously each
 * rule re-declared its own private `{ entries }` interface; sharing them here
 * keeps the dependency edge one-way and `dpdm` clean while stating the shape
 * once.
 */

/**
 * The slice of a queue entry consumed by rules that read raw patch bodies
 * (the new-file creators map, the binary-body check).
 */
export interface PatchQueueBodyEntry {
  /** Filename on disk and in the manifest. */
  filename: string;
  /** Raw unified-diff content of the patch body. */
  diff: string;
}

/**
 * The slice of a queue entry consumed by the module-registration rule: the
 * per-path content maps rather than the raw diff.
 */
export interface PatchQueueRegistrationEntry {
  /** Filename on disk and in the manifest. */
  filename: string;
  /** Newly-created file path → the content the patch would produce. */
  newFiles: ReadonlyMap<string, string>;
  /** Existing file path → the lines the patch adds to it. */
  modifiedFileAdditions: ReadonlyMap<string, string>;
}

/**
 * Structural queue view: the `entries` field of a `PatchQueueContext`,
 * narrowed to whichever entry slice a rule needs.
 */
export interface PatchQueueView<TEntry> {
  /** Entries in application order (lowest `order` first). */
  entries: readonly TEntry[];
}

/**
 * The slice consumed by the forward-registration rule: the same content maps
 * the module-registration rule reads, plus the body-kind-agnostic creation
 * set and the ordering/metadata needed to decide "later" and "declared".
 */
export interface PatchQueueForwardRegistrationEntry extends PatchQueueRegistrationEntry {
  /** Order number from the manifest (or filename prefix fallback). */
  order: number;
  /** Every path this patch creates, whatever the body kind. */
  createdFiles: ReadonlySet<string>;
  /** Manifest metadata. Null when the patch file exists but has no entry. */
  metadata: {
    stagedDependencies?: {
      registrations?: readonly { file: string; creates: string }[];
    };
  } | null;
}
