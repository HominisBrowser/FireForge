// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { prepareBuildEnvironment } from '../core/build-prepare.js';
import { getProjectPaths } from '../core/config.js';
import { readCoordinatorConfig } from '../core/jobs/admission-context.js';
import { coordinatorNamespace, readAdmittedSnapshot } from '../core/jobs/guard.js';
import { checkConfiguredObjdir, readHostToolchain } from '../core/jobs/native-tools.js';
import {
  assertReleaseRecipe,
  clearReleaseObjdir,
  collectReleaseOutputs,
  composeReleaseMozconfig,
  readReleaseOverlay,
  releaseIdentity,
  releaseObjdir,
} from '../core/jobs/release-recipe.js';
import { stepOutputDirectory } from '../core/jobs/step-environment.js';
import { writeDurable, writeDurableBytes } from '../core/jobs/store.js';
import { runMach } from '../core/mach.js';
import { BuildError } from '../errors/build.js';
import { info } from '../utils/logger.js';

/**
 * Builds and packages a release in a slot: frozen tools, the captured overlay last,
 * and an object directory of its own, emptied first, so the release is built from
 * clean and the slot's development build and its anchor are untouched.
 * `MOZ_BUILD_DATE` is pinned across both Mach runs, which otherwise mint different
 * build IDs. The declared outputs and the identity land in the step's output
 * directory, where whatever signs or checks the result reads them.
 *
 * @throws Outside a job, on a source with no recipe, or when configure lost a tool
 */
export async function packageRelease(projectRoot: string): Promise<void> {
  if (process.env['FIREFORGE_JOB_TOKEN'] === undefined)
    throw new BuildError('A release package runs in a job: fireforge job run --release', 'package');
  const namespace = coordinatorNamespace();
  const { snapshot, execution } = await readAdmittedSnapshot(projectRoot);
  if (execution === undefined) throw new BuildError('Release step has no identity', 'package');
  const coordinator = await readCoordinatorConfig(namespace);
  await assertReleaseRecipe(snapshot, coordinator);
  const release = snapshot.config.build?.release;
  if (release === undefined) throw new BuildError('Source declares no release', 'package');
  const paths = getProjectPaths(projectRoot);
  await prepareBuildEnvironment(projectRoot, paths, snapshot.config, {});
  const manifest = await readHostToolchain(namespace);
  await clearReleaseObjdir(projectRoot);
  const objdir = releaseObjdir(projectRoot);
  const mozconfig = join(projectRoot, '.fireforge', 'release', 'mozconfig');
  const generated = await readFile(join(paths.engine, 'mozconfig'), 'utf8');
  await writeDurableBytes(
    mozconfig,
    composeReleaseMozconfig(
      generated,
      await readReleaseOverlay(projectRoot, release.overlay),
      objdir
    )
  );
  const buildDate = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const env: Record<string, string> = {
    MOZCONFIG: mozconfig,
    MOZ_BUILD_DATE: buildDate,
    ...(release.secrets === undefined || coordinator.releaseSecrets === undefined
      ? {}
      : { [release.secrets.variable]: coordinator.releaseSecrets }),
  };
  for (const args of [['build', `-j${String(execution.cpu)}`], ['package']]) {
    info(`Release: mach ${args.join(' ')}`);
    const code = await runMach(args, paths.engine, { inherit: true, env });
    if (code !== 0)
      throw new BuildError(`mach ${args.join(' ')} exited ${String(code)}`, 'package');
    if (args[0] === 'build') await checkConfiguredObjdir(objdir, manifest);
  }
  const output = stepOutputDirectory(namespace, execution.jobId, execution.index, {
    command: 'package',
    args: execution.args,
  });
  if (output === undefined) return;
  const copied = await collectReleaseOutputs(objdir, release.outputs ?? [], output);
  for (const path of copied) info(`Release output: ${join(output, path)}`);
  await writeDurable(
    join(output, 'release.json'),
    await releaseIdentity({
      snapshot,
      root: projectRoot,
      toolchain: manifest.digest,
      buildDate,
    })
  );
}
