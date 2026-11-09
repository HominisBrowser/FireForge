// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { getNodeErrorCode } from '../../utils/errors.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import type { NativeToolchainManifest } from './slot-types.js';
import { readJson } from './store.js';
import { toolTreeDigest, treeStatSignature, withinRoots } from './tool-files.js';

export const NATIVE_PROBE =
  'import json,sys,sysconfig; print("FIREFORGE_NATIVE_PROBE:"+json.dumps({"executable":sys.executable,"prefix":sys.prefix,"paths":sys.path,"stdlib":sysconfig.get_path("stdlib"),"purelib":sysconfig.get_path("purelib"),"platlib":sysconfig.get_path("platlib")}))';
export interface NativeSiteRecord {
  name: string;
  root: string;
  digest: string;
  /** Compared per job instead of reading the site's bytes. */
  signature: string;
  probe: NativeProbe;
}
export interface NativeProbe {
  executable: string;
  prefix: string;
  paths: string[];
  stdlib?: string;
  purelib?: string;
  platlib?: string;
}
export interface NativeRuntimeRecord {
  schemaVersion: number;
  engineRoot: string;
  stateRoot: string;
  recipeDigest: string;
  toolchainDigest: string;
  gitDigest?: string;
  qualifiedAt: string;
  sites: NativeSiteRecord[];
}
/** Resolve the private writable state root for a stable slot. */
export function nativeStateRoot(projectRoot: string): string {
  return join(projectRoot, '.fireforge', 'native-state');
}
/** Store executable qualification separately from mutable Mach state. */
export function nativeRuntimePath(projectRoot: string): string {
  return join(projectRoot, '.fireforge', 'native-qualified.json');
}
/** Closed native adapters require Mach, common and build sites. */
export function nativeSites(manifest: NativeToolchainManifest): string[] {
  return [...new Set(['mach', 'common', 'build', ...(manifest.python.sites ?? [])])].sort();
}
/**
 * The sites a slot qualifies for a source: the toolchain's, and `taskgraph` when
 * the source declares a release. `mach package` resolves its DMG tools through
 * `mach taskgraph`, which provisions that site from `taskcluster/requirements.txt`
 * with hash-pinned pip, the same way the build site is provisioned. The build
 * digest binds only the toolchain's sites, since this one never reaches a build.
 */
export function qualifiedSites(
  manifest: NativeToolchainManifest,
  snapshot: AuthoredSnapshot
): string[] {
  const release = snapshot.config.build?.release === undefined ? [] : ['taskgraph'];
  return [...new Set([...nativeSites(manifest), ...release])].sort();
}
/** Keep unrelated UI edits warm while rebinding Mach/Python recipe changes. */
export function nativeRecipeDigest(snapshot: AuthoredSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        pin: snapshot.pin.commit,
        files: snapshot.files.filter(
          (file) =>
            file.path === 'mach' ||
            /^(?:python\/|third_party\/python\/|build\/mach)/.test(file.path)
        ),
      })
    )
    .digest('hex');
}
/** Match pinned Mach canonical-checkout hashing at the final stable slot path. */
export async function nativeSiteParent(projectRoot: string): Promise<string> {
  const engine = await realpath(join(projectRoot, 'engine'));
  const hash = createHash('sha256').update(engine).digest('hex').slice(0, 12);
  return join(nativeStateRoot(projectRoot), 'srcdirs', `engine-${hash}`, '_virtualenvs');
}
/** Ambient configuration/venv relocation never crosses the finite managed-state contract. */
export async function assertNativeStateBoundary(projectRoot: string): Promise<void> {
  for (const key of [
    'PYTHONPATH',
    'PYTHONHOME',
    'MOZCONFIG',
    'MOZ_OBJDIR',
    'MOZ_FETCHES_DIR',
    'MOZ_AUTOMATION',
    'WORKSPACE',
    'MACH_USE_SYSTEM_PYTHON',
    'MACH_SYSTEM_ASSERTED_COMPATIBLE_WITH_NATIVE_PACKAGES',
    'MACH_SYSTEM_ASSERTED_COMPATIBLE_WITH_RESTRICTED_VIRTUALENVS',
  ])
    if (process.env[key])
      throw new Error(
        `Native qualification does not support ambient ${key}; use an explicitly qualified local environment`
      );
  if (
    process.env['MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE'] &&
    process.env['MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE'] !== 'pip'
  )
    throw new Error('Native qualification requires Mach pip sites, never a system/none bypass');
  for (const path of [
    join(projectRoot, 'engine', '.machrc'),
    join(nativeStateRoot(projectRoot), 'machrc'),
    join(nativeStateRoot(projectRoot), '.machrc'),
  ]) {
    try {
      await access(path);
      throw new Error(`Unqualified ambient Mach configuration: ${path}`);
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
  }
  const parent = await nativeSiteParent(projectRoot);
  for (const path of [
    join(projectRoot, '.fireforge'),
    nativeStateRoot(projectRoot),
    join(nativeStateRoot(projectRoot), 'srcdirs'),
    join(parent, '..'),
    parent,
  ]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Native state cannot alias another checkout');
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
  }
  try {
    const path = join(nativeStateRoot(projectRoot), 'empty-machrc'),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await readFile(path, 'utf8')) !== '')
      throw new Error('Managed empty Mach config is not an owned empty regular file');
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
}
/** Decode only the fixed probe marker, never arbitrary command success. */
function parseNativeProbe(output: string): NativeProbe {
  const line = output.split('\n').findLast((line) => line.startsWith('FIREFORGE_NATIVE_PROBE:'));
  const value: unknown = JSON.parse(line?.slice('FIREFORGE_NATIVE_PROBE:'.length) ?? 'null');
  if (
    !value ||
    typeof value !== 'object' ||
    !('executable' in value) ||
    typeof value.executable !== 'string' ||
    !('prefix' in value) ||
    typeof value.prefix !== 'string' ||
    !('paths' in value) ||
    !Array.isArray(value.paths) ||
    !value.paths.every((path) => typeof path === 'string')
  )
    throw new Error('Managed Mach site emitted no valid fixed runtime probe');
  return value as NativeProbe;
}
/**
 * Source paths are separately audited; mutable object/state directories never
 * become executable roots. `external` holds the toolchain's roots and this slot's
 * other sites: a real `common` or `build` site names `mach`'s site-packages, and
 * every site in the roster is measured beside it.
 */
export async function validateNativeProbe(
  probe: NativeProbe,
  root: string,
  projectRoot: string,
  external: readonly string[]
): Promise<void> {
  const engine = await realpath(join(projectRoot, 'engine'));
  if ((await realpath(probe.prefix)) !== (await realpath(root)))
    throw new Error('Mach site resolved to another virtualenv prefix');
  for (const path of [
    probe.executable,
    ...probe.paths,
    probe.stdlib,
    probe.purelib,
    probe.platlib,
  ]) {
    if (!path) continue;
    let actual: string;
    try {
      actual = await realpath(path);
    } catch (error) {
      if (getNodeErrorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const source = relative(engine, actual);
    const managedSource =
      withinRoots(actual, [engine]) &&
      !source.split(sep).some((part) => part.startsWith('.') || part.startsWith('obj-'));
    if (!withinRoots(actual, [await realpath(root), ...external]) && !managedSource)
      throw new Error(`Uncovered managed Python runtime path: ${actual}`);
  }
}
/** Inspect the actual qualified site interpreter without running Mach installers. */
export async function probeNativeSite(root: string): Promise<NativeProbe> {
  const output = await promisify(execFile)(
    join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    ['-I', '-B', '-c', NATIVE_PROBE],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    }
  );
  return parseNativeProbe(output.stdout);
}

/** One site's identity: its stat signature for jobs, its bytes for a qualification or final gate. */
export async function measureSite(
  root: string,
  external: readonly string[]
): Promise<{ digest: string; signature: string }> {
  return {
    digest: await toolTreeDigest(root, { aliases: external }),
    signature: await treeStatSignature([root]),
  };
}

/**
 * Confirms a slot's Mach sites are the ones it qualified with. Sibling locks and
 * private caches are writable on purpose and stay out. A job compares stat
 * signatures; `full` reads the bytes and asks the interpreters how they resolve.
 *
 * @throws With the command that repairs it, when the recipe or the tools moved
 */
export async function verifyQualifiedSites(
  snapshot: AuthoredSnapshot,
  manifest: NativeToolchainManifest,
  projectRoot: string,
  options: { full?: boolean } = {}
): Promise<NativeRuntimeRecord> {
  await assertNativeStateBoundary(projectRoot);
  let record: NativeRuntimeRecord;
  try {
    record = await readJson(nativeRuntimePath(projectRoot));
  } catch (error) {
    throw new Error(
      `Managed Mach sites are not qualified; run: fireforge slot qualify-native ${basename(dirname(projectRoot))}`,
      { cause: error }
    );
  }
  const engine = await realpath(join(projectRoot, 'engine')),
    state = await realpath(nativeStateRoot(projectRoot));
  if (
    record.schemaVersion !== 2 ||
    record.engineRoot !== engine ||
    record.stateRoot !== state ||
    record.recipeDigest !== nativeRecipeDigest(snapshot) ||
    record.toolchainDigest !== manifest.digest
  )
    throw new Error(
      `The Mach recipe or the toolchain changed since this slot qualified; run: fireforge slot qualify-native ${basename(dirname(projectRoot))}`
    );
  const expected = qualifiedSites(manifest, snapshot),
    parent = await nativeSiteParent(projectRoot),
    recorded = record.sites.map((site) => site.name).sort();
  if (JSON.stringify(recorded) !== JSON.stringify(expected))
    throw new Error(
      `This slot qualified the Mach sites ${recorded.join(', ')} and this source needs ${expected.join(', ')}; run: fireforge slot qualify-native ${basename(dirname(projectRoot))}`
    );
  const actual = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const foreign = actual.filter((name) => !expected.includes(name));
  if (foreign.length > 0)
    throw new Error(`Unexpected/unqualified Mach virtualenv site: ${foreign.join(', ')}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Qualified Mach site missing: ${expected.filter((name) => !actual.includes(name)).join(', ')}`
    );
  const external = await Promise.all(
    [...manifest.python.roots, ...manifest.native.roots].map((path) => realpath(path))
  );
  const sites = record.sites.map((site) => site.root);
  for (const site of record.sites) {
    if (
      site.root !== (await realpath(join(parent, site.name))) ||
      (await lstat(join(parent, site.name))).isSymbolicLink()
    )
      throw new Error('Qualified Mach site aliases another generation');
    if (options.full !== true && (await treeStatSignature([site.root])) === site.signature)
      continue;
    if ((await toolTreeDigest(site.root, { aliases: external })) !== site.digest)
      throw new Error('Qualified Mach executable/package bytes changed');
    if (options.full === true) {
      const probe = await probeNativeSite(site.root);
      await validateNativeProbe(probe, site.root, projectRoot, [...external, ...sites]);
      if (JSON.stringify(probe) !== JSON.stringify(site.probe))
        throw new Error('Actual managed Python resolution changed');
    }
  }
  if ((await readFile(join(state, 'empty-machrc'), 'utf8')) !== '')
    throw new Error('Managed empty Mach configuration changed');
  return record;
}
