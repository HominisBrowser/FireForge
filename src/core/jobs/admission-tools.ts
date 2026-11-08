// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuthoredSnapshot } from '../authored/types.js';
import { gitToolIdentity } from './git-tools.js';
import { nativeToolIdentity, needsNativeTools, readHostToolchain } from './native-tools.js';
import { qualityToolIdentity } from './quality-tools.js';
import type { JobRecord, JobStep } from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { stepTraits } from './step-traits.js';
import { readJson, writeDurable } from './store.js';

/** Acquire actual tool inputs under this phase's resources before starting its adapter. */
export async function preparePhaseTools(
  namespace: string,
  job: JobRecord,
  slot: SlotRecord,
  step: JobStep | undefined
): Promise<void> {
  const snapshot = await readJson<AuthoredSnapshot>(
    join(namespace, 'slots', slot.id, 'snapshot.json')
  );
  const git = job.gitExecutable === undefined ? await gitToolIdentity() : undefined;
  if (git !== undefined) {
    job.gitExecutable = git.executable;
    job.gitExecPath = git.execPath;
  }
  if (job.qualityToolsDigest === undefined) {
    const start = performance.now();
    job.qualityToolsDigest = await qualityToolIdentity(slot.root, git);
    job.toolIdentityTimings = {
      ...job.toolIdentityTimings,
      qualityInitialMs: performance.now() - start,
    };
  }
  if (!step || !needsNativeTools(step, snapshot)) return;
  if (stepTraits(step).readsPackage && (slot.requiresBuild || !slot.trustedBuild))
    throw new Error(
      'Runtime source requires a fresh admitted build before testing, running or packaging'
    );
  if (job.nativeToolsDigest === undefined) {
    const start = performance.now();
    job.nativeToolsDigest = await nativeToolIdentity({
      namespace,
      snapshot,
      projectRoot: slot.root,
      steps: job.request.steps,
    });
    job.toolIdentityTimings = {
      ...job.toolIdentityTimings,
      nativeInitialMs: performance.now() - start,
    };
  }
  const anchor = slot.fullBuildAnchor;
  if (anchor?.nativeToolsDigest !== job.nativeToolsDigest) {
    slot.requiresFullBuild = true;
    slot.requiresBuild = true;
    delete slot.trustedBuild;
    // Objects the same toolchain made stay: a failed build or a Mach recipe change needs a rebuild, not a clobber.
    const { digest: toolchain } = await readHostToolchain(namespace);
    if (
      slot.objdirToolsDigest !== toolchain &&
      (await readdir(join(slot.root, 'engine'))).some((name) => name.startsWith('obj-'))
    )
      slot.requiresToolchainClean = true;
    await writeDurable(join(namespace, 'slots', slot.id, 'slot.json'), slot);
  }
}

/**
 * Sealing compares the tools again, by stat signature, and by every byte when the
 * request is a final gate.
 */
export async function sealToolIdentity(
  namespace: string,
  slot: SlotRecord,
  job: JobRecord,
  snapshot: AuthoredSnapshot
): Promise<{ qualityToolsDigest: string; nativeToolsDigest?: string }> {
  let start = performance.now();
  const quality = await qualityToolIdentity(slot.root, undefined, {
    full: job.request.finalGate === true,
  });
  job.toolIdentityTimings = {
    ...job.toolIdentityTimings,
    qualitySealMs: performance.now() - start,
  };
  if (job.qualityToolsDigest === undefined || quality !== job.qualityToolsDigest)
    throw new Error('Resolved quality tools/config/assets changed during the campaign');
  start = performance.now();
  const native =
    job.nativeToolsDigest === undefined
      ? undefined
      : await nativeToolIdentity({
          namespace,
          snapshot,
          projectRoot: slot.root,
          steps: job.request.steps,
          strictConfigured: true,
          full: job.request.finalGate === true,
        });
  if (native !== undefined)
    job.toolIdentityTimings = {
      ...job.toolIdentityTimings,
      nativeSealMs: performance.now() - start,
    };
  if (native !== job.nativeToolsDigest)
    throw new Error('Native toolchain runtime bytes changed during the campaign');
  return {
    qualityToolsDigest: quality,
    ...(native === undefined ? {} : { nativeToolsDigest: native }),
  };
}
