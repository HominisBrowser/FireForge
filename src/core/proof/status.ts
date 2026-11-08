// SPDX-License-Identifier: EUPL-1.2
import { authenticateAuthoredSnapshot } from '../authored/provider.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import {
  type CarriedEvidence,
  evaluateProof,
  type ProofStatus,
  readDecisions,
  readEvidence,
} from './evidence.js';
import { type CurrentIdentity, measureCurrentIdentity } from './identity.js';
import { retainedSnapshotsOfTree } from './publish.js';
import { type CleanGateProbe, planCapturedSource } from './snapshot.js';
import type { ProofPlan } from './types.js';

/**
 * The plan against the tools as they are now. A gate's claim also reads every
 * toolchain byte, since a job compares only a stat signature. With no passed result
 * there is nothing to compare, so measuring costs a first run nothing.
 */
export async function currentStatus(
  namespace: string,
  plan: ProofPlan,
  options: { claim?: boolean } = {}
): Promise<{ status: ProofStatus; identity: CurrentIdentity }> {
  const store = await readEvidence(namespace, plan.source);
  const carried: CarriedEvidence | undefined =
    plan.carry === undefined
      ? undefined
      : {
          store: await readEvidence(namespace, plan.carry.source),
          decisions: await readDecisions(namespace, plan.carry.source, plan.tier),
        };
  const identity = await measureCurrentIdentity(
    namespace,
    plan.source,
    [store, carried?.store].some((entry) => entry?.rows.some((row) => row.status === 'passed')),
    options.claim === true && plan.tier === 'gate'
  );
  return {
    status: evaluateProof(
      plan,
      store,
      await readDecisions(namespace, plan.source, plan.tier),
      identity,
      carried
    ),
    identity,
  };
}

/**
 * Answers whether an ancestor's tree has complete gate evidence of its own, by the
 * rules publish holds it to: its gate planned as that commit's own, every obligation
 * met under the present tools, nothing waived. Evidence that is itself carried, or
 * planned against a narrowed base, never counts; a verified carry already reaches it.
 *
 * @param namespace - The coordinator namespace holding the evidence
 * @param root - The checkout whose history the ancestor's plan resolves in
 * @param donor - The pristine repository a retained snapshot authenticates against
 */
export function cleanGateProbe(namespace: string, root: string, donor: string): CleanGateProbe {
  const retained = new Map<string, Promise<AuthoredSnapshot[]>>();
  const ofTree = (tree: string): Promise<AuthoredSnapshot[]> => {
    const known = retained.get(tree) ?? retainedSnapshotsOfTree(namespace, tree);
    retained.set(tree, known);
    return known;
  };
  return async (commit, tree, source) => {
    for (const candidate of await ofTree(tree)) {
      if (candidate.id !== source) continue;
      const snapshot = await authenticateAuthoredSnapshot(candidate, donor);
      const plan = await planCapturedSource({ root, snapshot, tier: 'gate', head: commit });
      if (plan.carry !== undefined || plan.base.narrowed) continue;
      const { status } = await currentStatus(namespace, plan);
      if (status.complete && status.waived.length === 0) return true;
    }
    return false;
  };
}
