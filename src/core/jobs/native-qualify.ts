// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuthoredSnapshot } from '../authored/types.js';
import { runMach } from '../mach.js';
import { attemptMozinfoRewrite, findObjdirRelocationViolation } from '../mach-build-artifacts.js';
import { prepareBuildDerived } from './build-derived.js';
import { submitJob, waitForJob } from './client.js';
import { gitToolIdentity } from './git-tools.js';
import { coordinatorNamespace, readAdmittedSnapshot } from './guard.js';
import {
  assertNativeStateBoundary,
  measureSite,
  NATIVE_PROBE,
  nativeRecipeDigest,
  nativeRuntimePath,
  type NativeRuntimeRecord,
  nativeSiteParent,
  nativeStateRoot,
  probeNativeSite,
  qualifiedSites,
  validateNativeProbe,
  verifyQualifiedSites,
} from './native-state.js';
import {
  assertNativeBootstrapDisabled,
  assertPythonResolution,
  assertToolchainCurrent,
  checkConfiguredTools,
  readHostToolchain,
} from './native-tools.js';
import type { JobView } from './schema.js';
import type { NativeToolchainManifest } from './slot-types.js';
import { readSlot } from './slots.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

/** Makes a site's contents read-only, or writable again so it can be reprovisioned or removed. */
async function changeSitePermissions(path: string, frozen: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    if (!frozen) await chmod(path, 0o700);
    for (const name of await readdir(path)) await changeSitePermissions(join(path, name), frozen);
    if (frozen) await chmod(path, 0o555);
  } else if (info.isFile())
    await chmod(
      path,
      frozen ? (info.mode & 0o111 ? 0o555 : 0o444) : info.mode & 0o111 ? 0o700 : 0o600
    );
  else throw new Error('Unsupported managed virtualenv entry');
}

/** Runs the fixed Mach probe in one site, which is what makes Mach provision it. */
async function provisionSite(
  manifest: NativeToolchainManifest,
  root: string,
  site: string
): Promise<void> {
  const engine = join(root, 'engine');
  const child = spawn(
    manifest.python.executable,
    ['-B', join(engine, 'mach'), 'python', '--virtualenv', site, '-c', NATIVE_PROBE],
    { cwd: engine, stdio: 'inherit' }
  );
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`Mach site ${site} provision failed (${code ?? 'signal'})`);
}

/**
 * Provisions the sites at their final path, then freezes what they contain. A
 * site the slot's earlier qualification did not record was made by a job, not
 * by a qualification, so it is removed and provisioned afresh; one it recorded
 * that this source no longer needs is removed.
 */
async function prepareSites(
  manifest: NativeToolchainManifest,
  root: string,
  expected: readonly string[],
  recorded: readonly string[] | undefined
): Promise<void> {
  const parent = await nativeSiteParent(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error('Managed virtualenv site cannot alias another tree');
    if (
      !entry.isDirectory() &&
      ![...expected, ...(recorded ?? [])].some((site) => entry.name === `${site}.lock`)
    )
      throw new Error('Unexpected file in managed virtualenv parent');
    if (entry.isDirectory()) {
      const wanted = expected.includes(entry.name),
        qualified = recorded?.includes(entry.name);
      if (!wanted && qualified !== true)
        throw new Error(
          `Unexpected Mach site ${entry.name}; retire/recreate the isolated slot before qualification`
        );
      await changeSitePermissions(join(parent, entry.name), false);
      if (!wanted || qualified === false) await rm(join(parent, entry.name), { recursive: true });
    }
  }
  for (const site of expected.filter((name) => name !== 'mach'))
    await provisionSite(manifest, root, site);
  for (const site of expected) await changeSitePermissions(join(parent, site), true);
}

/**
 * Runs configure in the slot, relocating any object directory a clone brought
 * along, then holds what it selected against the manifest. This is what catches
 * an incomplete manifest while it costs a few minutes rather than a whole build.
 */
async function configureAndCheck(
  namespace: string,
  id: string,
  root: string,
  snapshot: AuthoredSnapshot,
  manifest: NativeToolchainManifest
): Promise<void> {
  const engine = join(root, 'engine');
  await prepareBuildDerived(namespace, await readSlot(namespace, id), snapshot, true);
  const relocated: Array<{ name: string; from: string }> = [];
  for (const entry of await readdir(engine, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('obj-')) continue;
    const mozinfo = await readJson<{ topsrcdir?: string }>(
      join(engine, entry.name, 'mozinfo.json')
    ).catch(() => undefined);
    if (mozinfo?.topsrcdir === undefined || mozinfo.topsrcdir === (await realpath(engine)))
      continue;
    const rewrite = await attemptMozinfoRewrite(engine, entry.name);
    if (!rewrite.rewritten)
      throw new Error(`Cannot relocate ${entry.name}: ${rewrite.reason ?? 'rewrite refused'}`);
    await rm(join(engine, entry.name, '_virtualenvs'), { recursive: true, force: true });
    relocated.push({ name: entry.name, from: mozinfo.topsrcdir });
  }
  const code = await runMach(['configure'], engine, { inherit: true });
  if (code !== 0) throw new Error(`mach configure failed (${code})`);
  for (const { name, from } of relocated) {
    const violation = await findObjdirRelocationViolation({
      engineDir: engine,
      objDir: name,
      forbiddenDir: from,
    });
    if (violation !== undefined) throw new Error(`Relocation incomplete: ${violation}`);
  }
  await checkConfiguredTools(engine, manifest);
}

/** Measures the sites a provisioning left. */
async function measureSites(
  manifest: NativeToolchainManifest,
  root: string,
  names: readonly string[]
): Promise<NativeRuntimeRecord['sites']> {
  const external = await Promise.all(
    [...manifest.python.roots, ...manifest.native.roots].map((path) => realpath(path))
  );
  const parent = await nativeSiteParent(root);
  const roots = await Promise.all(names.map((name) => realpath(join(parent, name))));
  const sites: NativeRuntimeRecord['sites'] = [];
  for (const [index, name] of names.entries()) {
    const site = roots[index] ?? '';
    const probe = await probeNativeSite(site);
    await validateNativeProbe(probe, site, root, [...external, ...roots]);
    sites.push({ name, root: site, probe, ...(await measureSite(site, external)) });
  }
  return sites;
}

/**
 * The body of a `qualify-native` phase, in the executor. It is an ordinary owned
 * job, so everything Mach and pip start is in the phase's process group and
 * census, and a peer's job on another slot does not wait for it.
 */
export async function runQualificationPhase(root: string): Promise<void> {
  const namespace = coordinatorNamespace();
  const { snapshot, slot } = await readAdmittedSnapshot(root);
  const manifest = await readHostToolchain(namespace);
  await assertNativeBootstrapDisabled(snapshot);
  await assertNativeStateBoundary(root);
  await assertToolchainCurrent(manifest, { full: true });
  await assertPythonResolution(manifest);
  const current = await verifyQualifiedSites(snapshot, manifest, root).catch(() => undefined);
  if (current !== undefined) return;
  const previous = await readJson<NativeRuntimeRecord>(nativeRuntimePath(root)).catch(
    () => undefined
  );
  const sites = qualifiedSites(manifest, snapshot);
  await rm(nativeRuntimePath(root), { force: true });
  const state = nativeStateRoot(root);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'empty-machrc'), '');
  await prepareSites(
    manifest,
    root,
    sites,
    previous?.sites.map((site) => site.name)
  );
  await configureAndCheck(namespace, slot.id, root, snapshot, manifest);
  const record: NativeRuntimeRecord = {
    schemaVersion: 2,
    engineRoot: await realpath(join(root, 'engine')),
    stateRoot: await realpath(state),
    recipeDigest: nativeRecipeDigest(snapshot),
    toolchainDigest: manifest.digest,
    gitDigest: (await gitToolIdentity()).digest,
    qualifiedAt: new Date().toISOString(),
    sites: await measureSites(manifest, root, sites),
  };
  await writeDurable(nativeRuntimePath(root), record);
}

/**
 * Submits a slot's qualification as a job and waits for it. It runs on `source`,
 * or on whatever the slot already holds.
 */
export async function qualifySlotNativeTools(
  namespace: string,
  id: string,
  source?: AuthoredSnapshot
): Promise<JobView> {
  await readHostToolchain(namespace);
  await readSlot(namespace, id);
  const snapshot =
    source ??
    (await readJson<AuthoredSnapshot>(join(slotDirectory(namespace, id), 'snapshot.json')));
  const job = await submitJob(
    namespace,
    {
      schemaVersion: 1,
      key: `qualify-${id}-${randomUUID()}`,
      slot: id,
      sourceId: snapshot.id,
      steps: [{ command: 'qualify-native', args: [] }],
      quiet: false,
    },
    snapshot
  );
  return waitForJob(namespace, job.id, Number.POSITIVE_INFINITY, (reason) => {
    process.stderr.write(`Slot ${id} qualification waiting: ${reason}\n`);
  });
}
