// SPDX-License-Identifier: EUPL-1.2
import { readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { runMach } from '../mach.js';
import { assertExecutorCommand, coordinatorNamespace, readAdmittedSnapshot } from './guard.js';
import { readHostToolchain, toolchainRoots } from './native-tools.js';
import { writeDurable } from './store.js';

/** Clean only the owned private objdir under the existing build adapter and its full resource lease. */
export async function prepareOwnedBuildClean(
  projectRoot: string,
  engine: string,
  ui: boolean
): Promise<void> {
  if (process.env['FIREFORGE_JOB_TOKEN'] === undefined) return;
  await assertExecutorCommand('build', projectRoot);
  const admitted = await readAdmittedSnapshot(projectRoot);
  if (!admitted.slot.requiresToolchainClean) return;
  if (ui)
    throw new Error(
      'Changed/unqualified native tools require clobber and a full build, never --ui'
    );
  if (!admitted.nativeToolsDigest)
    throw new Error('Clean build has no authenticated qualified tool identity');
  const manifest = await readHostToolchain(coordinatorNamespace());
  const roots = await Promise.all(toolchainRoots(manifest).map((path) => realpath(path)));
  const canonicalEngine = await realpath(engine);
  for (const entry of await readdir(canonicalEngine, { withFileTypes: true }))
    if (entry.name.startsWith('obj-')) {
      if (entry.isSymbolicLink())
        throw new Error('Refusing clobber with a symbolic-link object directory');
      if (!entry.isDirectory()) continue;
      const object = await realpath(join(canonicalEngine, entry.name));
      if (
        roots.some(
          (root) =>
            root === object || root.startsWith(object + sep) || object.startsWith(root + sep)
        )
      )
        throw new Error(
          'Immutable tool roots overlap clobber targets; provision tool/venv generations outside mutable objdirs'
        );
    }
  const code = await runMach(['clobber', 'objdir', '--full'], engine);
  if (code !== 0)
    throw new Error(`Owned toolchain clobber failed (${code}); clean/full requirement remains`);
  const job = process.env['FIREFORGE_JOB_ID'];
  if (!job) throw new Error('Missing owned build job');
  await writeDurable(
    join(coordinatorNamespace(), 'artifacts', job, `clean-${admitted.phase}.json`),
    {
      sourceId: admitted.snapshot.id,
      generation: admitted.slot.generation,
      phase: admitted.phase,
      jobId: job,
      nativeToolsDigest: admitted.nativeToolsDigest,
    }
  );
}
