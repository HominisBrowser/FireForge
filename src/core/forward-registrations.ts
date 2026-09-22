// SPDX-License-Identifier: EUPL-1.2
/**
 * Public, queue-level entry point to the `forward-registration` census.
 *
 * A consumer that keeps its own audit (a ratchet baseline over forward
 * edges, say) runs the rule's own predicate here instead of mirroring it.
 * Lives apart from the rule module because it builds the queue context,
 * which imports the rule back.
 */
import type { FireForgeConfig } from '../types/config.js';
import { buildPatchQueueContext } from './patch-lint-cross.js';
import { collectForwardRegistrations } from './patch-lint-forward-registration.js';
import type {
  ForwardRegistration,
  ForwardRegistrationScope,
} from './patch-lint-forward-registration-extended.js';

/** Options for {@link findForwardRegistrations}. */
export interface FindForwardRegistrationsOptions {
  /**
   * Which carriers to check. Defaults to `'extended'` (every carrier the
   * rule can resolve), since a census wants the whole picture whatever the
   * lint gate is configured to enforce.
   */
  scope?: ForwardRegistrationScope;
  /** Project config, for the queue's patchPolicy ordering context. Optional. */
  config?: FireForgeConfig;
}

/**
 * Lists every undeclared forward registration in a patch queue: a line a
 * patch adds (to a test manifest, jar.mn, moz.build or customElements.js)
 * that names a file only a later-ordered patch creates. Each record carries
 * the paste-and-run `patch staged-dependency` command that declares it.
 *
 * @param patchesDir - The project's `patches/` directory
 * @param options - Scope and optional config
 * @returns One record per (patch, carrier file, created file)
 */
export async function findForwardRegistrations(
  patchesDir: string,
  options: FindForwardRegistrationsOptions = {}
): Promise<ForwardRegistration[]> {
  const ctx = await buildPatchQueueContext(patchesDir, options.config);
  return collectForwardRegistrations(ctx, options.scope ?? 'extended');
}

export type {
  ForwardRegistration,
  ForwardRegistrationKind,
  ForwardRegistrationScope,
} from './patch-lint-forward-registration-extended.js';
