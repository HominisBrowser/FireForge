// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { readBuildBaseline } from '../build-baseline.js';
import { signPackage } from './package-signature.js';
import { releaseObjdir } from './release-recipe.js';
import type { JobStep } from './schema.js';
import type { BuildToolContext, SlotRecord } from './slot-types.js';
import { readSlot } from './slots.js';
import { compiledSourceDigest } from './source-build.js';
import { stepTraits } from './step-traits.js';
import { directoryPhysicalBytes } from './storage.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

/** Measure the object directories after a full build, so a reservation counts only what can still grow. */
async function recordSlotGrowth(slot: SlotRecord): Promise<void> {
  if (slot.storage === undefined) return;
  const engine = join(slot.root, 'engine');
  let bytes = 0;
  for (const name of await readdir(engine))
    if (name.startsWith('obj-')) bytes += await directoryPhysicalBytes(join(engine, name));
  slot.storage.consumedBytes = bytes;
}

/** Failed or mismatched cleaning can never be promoted by a later faster/full exit alone. */
async function assertCleanBuildProof(
  namespace: string,
  slot: SlotRecord,
  kind: string | undefined,
  tools: BuildToolContext | undefined
): Promise<void> {
  if (!slot.requiresToolchainClean) return;
  if (kind !== 'full' || !tools) throw new Error('Toolchain clean/full requirement remains');
  const proof = await readJson<Record<string, unknown>>(
    join(namespace, 'artifacts', tools.jobId, `clean-${tools.phase}.json`)
  );
  if (
    proof['sourceId'] !== slot.sourceId ||
    proof['generation'] !== slot.generation ||
    proof['jobId'] !== tools.jobId ||
    proof['phase'] !== tools.phase ||
    proof['nativeToolsDigest'] !== tools.nativeToolsDigest
  )
    throw new Error('No matching successful clobber proof for this full build');
}

/** Advance only after a successful existing build adapter and its actual packaged baseline. */
export async function recordSuccessfulBuild(
  namespace: string,
  slotId: string,
  step: JobStep,
  completedCompiledRestore = false,
  startedAt?: string,
  tools?: BuildToolContext
): Promise<void> {
  const slot = await readSlot(namespace, slotId);
  if (!completedCompiledRestore && !stepTraits(step).builds) {
    const release = stepTraits(step).releaseBuild && slot.storage !== undefined;
    const signed = step.command === 'package' && slot.packageSignature !== undefined;
    // Packaging writes beside what it packages, and its start already checked what it read.
    if (signed) slot.packageSignature = await signPackage(slot.root);
    if (release && slot.storage !== undefined)
      slot.storage.releaseBytes = await directoryPhysicalBytes(releaseObjdir(slot.root)).catch(
        (error: unknown) => {
          if (getNodeErrorCode(error) === 'ENOENT') return 0;
          throw error;
        }
      );
    if (signed || release)
      await writeDurable(join(slotDirectory(namespace, slotId), 'slot.json'), slot);
    return;
  }
  const baseline = await readFile(join(slot.root, '.fireforge', 'last-build.json'));
  const parsed = await readBuildBaseline(slot.root, 'refuse');
  const snapshot = await readJson<AuthoredSnapshot>(
    join(slotDirectory(namespace, slotId), 'snapshot.json')
  );
  if (
    !parsed ||
    !['full', 'faster'].includes(parsed.buildKind ?? '') ||
    parsed.engineHeadSha !== slot.pin ||
    parsed.binaryName !== snapshot.config.binaryName ||
    parsed.controlBuild ||
    (startedAt !== undefined &&
      (!Number.isFinite(Date.parse(startedAt)) ||
        Date.parse(parsed.builtAt) < Date.parse(startedAt)))
  )
    throw new Error('Successful build adapter has no fresh coherent structured package baseline');
  const compiledDigest = compiledSourceDigest(snapshot, slot.buildRecipeDigest);
  const toolMismatch =
    tools !== undefined && slot.fullBuildAnchor?.nativeToolsDigest !== tools.nativeToolsDigest;
  if (parsed.buildKind !== 'full' && toolMismatch)
    throw new Error('Faster build cannot promote a binary from a different actual toolchain');
  await assertCleanBuildProof(namespace, slot, parsed.buildKind, tools);
  if (
    parsed.buildKind !== 'full' &&
    (slot.requiresFullBuild || slot.fullBuildAnchor?.digest !== compiledDigest)
  )
    throw new Error(
      'A faster build cannot establish the current compiled source; an admitted full build is required'
    );
  const ledger = await readFile(join(slotDirectory(namespace, slotId), 'materialization.json'));
  slot.successfulBuildGeneration += 1;
  slot.requiresBuild = false;
  slot.requiresFullBuild = false;
  slot.requiresToolchainClean = false;
  if (parsed.buildKind === 'full') {
    await recordSlotGrowth(slot);
    slot.fullBuildAnchor = {
      digest: compiledDigest,
      baselineDigest: createHash('sha256').update(baseline).digest('hex'),
      sourceId: slot.sourceId,
      buildGeneration: slot.successfulBuildGeneration,
      ...(tools === undefined ? {} : { nativeToolsDigest: tools.nativeToolsDigest }),
    };
  }
  slot.packageSignature = await signPackage(slot.root);
  slot.trustedBuild = {
    sourceId: slot.sourceId,
    slotGeneration: slot.generation,
    materializationDigest: createHash('sha256').update(ledger).digest('hex'),
    successfulBuildGeneration: slot.successfulBuildGeneration,
    baselineDigest: createHash('sha256').update(baseline).digest('hex'),
  };
  await writeDurable(join(slotDirectory(namespace, slotId), 'slot.json'), slot);
}
