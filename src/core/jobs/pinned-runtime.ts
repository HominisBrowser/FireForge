// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { formatVersionWithIdentity, readBuildInfoFile } from '../../utils/build-info.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { isFireForgePackageMetadata } from '../../utils/package-root.js';
import { dependencyGraphIdentity } from './dependency-identity.js';
import { COORDINATOR_PROTOCOL } from './protocol.js';
import type { CoordinatorConfig } from './schema.js';
import { readJson, writeDurable } from './store.js';
import { fileDigest, walkTree } from './tool-files.js';

const run = promisify(execFile);

const pathPresent = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

/** A runtime tree holds plain files the copy made writable, so removing one needs no more. */
const removeTree = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

/** One FireForge build copied into a namespace, as `host upgrade` verified it. */
export interface PinnedBuild {
  /** The directory under `<namespace>/runtime/` that holds it: its digest's first 16 hex characters. */
  id: string;
  /** Its version and build identity, as `--version` prints them. */
  version: string;
  /** Every byte of the copied package, which a supervisor start checks again. */
  digest: string;
  /** The executor fingerprint the copy reports for itself, which every job it runs carries. */
  executorDigest: string;
  /** The coordinator protocol it speaks; a client that speaks another cannot submit to it. */
  protocol: number;
  /** The package directory it was copied from. */
  source: string;
  pinnedAt: string;
}

/** Which build the host runs, and the one before it for a rollback. */
export interface PinnedRuntimeRecord {
  schemaVersion: 1;
  current: PinnedBuild;
  previous?: PinnedBuild;
}

/** A pinned runtime that is missing, changed or unusable: nothing may run from it. */
export class PinnedRuntimeError extends Error {
  override readonly name = 'PinnedRuntimeError';
}

const runtimeRoot = (namespace: string): string => join(namespace, 'runtime');
const recordPath = (namespace: string): string => join(runtimeRoot(namespace), 'current.json');

/** The package root a pinned build lives at. */
export const pinnedPackage = (namespace: string, build: Pick<PinnedBuild, 'id'>): string =>
  join(runtimeRoot(namespace), build.id);

/** The entry points a package has to carry to run a supervisor and the CLI. */
const SUPERVISOR_ENTRY = join('dist', 'src', 'core', 'jobs', 'supervisor-main.js');
const CLI_ENTRY = join('dist', 'bin', 'fireforge.js');

/** What `npm pack` leaves out of `dist/`, and so what no runtime needs. */
const skipShipped = (name: string): boolean =>
  name === '__tests__' ||
  name === 'test-utils' ||
  name.includes('.test.') ||
  name.endsWith('.js.map') ||
  name.endsWith('.d.ts');

/** The pinned build this namespace runs, or undefined when it runs whatever client starts it. */
export async function readPinnedRuntime(
  namespace: string
): Promise<PinnedRuntimeRecord | undefined> {
  try {
    return await readJson<PinnedRuntimeRecord>(recordPath(namespace));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Every byte of a runtime tree, by path. A link has no place in one. */
async function runtimeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  await walkTree(root, async ({ path, label, info }) => {
    if (info.isSymbolicLink())
      throw new PinnedRuntimeError(`A pinned runtime holds no links, and ${label} is one`);
    if (info.isFile())
      hash.update(JSON.stringify([label, info.mode & 0o111])).update(await fileDigest(path, info));
    else if (!info.isDirectory())
      throw new PinnedRuntimeError(`Unsupported pinned runtime entry: ${label}`);
  });
  return hash.digest('hex');
}

/**
 * Checks a pinned build's bytes against what `host upgrade` recorded, before
 * anything runs from it.
 *
 * @returns Its package root
 * @throws {PinnedRuntimeError} When it is missing or any byte differs
 */
async function verifyPinnedBuild(namespace: string, build: PinnedBuild): Promise<string> {
  const root = pinnedPackage(namespace, build);
  const remedy = 'pin a build again: fireforge host upgrade --from <package directory>';
  let digest: string;
  try {
    digest = await runtimeDigest(root);
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    throw new PinnedRuntimeError(
      `The host's pinned FireForge ${build.version} is missing from ${root}; ${remedy}`,
      { cause: error }
    );
  }
  if (digest !== build.digest)
    throw new PinnedRuntimeError(
      `The host's pinned FireForge ${build.version} at ${root} is not the bytes host upgrade verified; ${remedy}`
    );
  return root;
}

/** Copies one tree, refusing links: nothing in a runtime may point outside it. */
async function copyTree(
  source: string,
  destination: string,
  skip?: (name: string) => boolean
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await walkTree(
    source,
    async ({ path, label, info }) => {
      const target = join(destination, label);
      if (info.isSymbolicLink())
        throw new PinnedRuntimeError(`${path} is a link; a pinned runtime copies files only`);
      if (info.isDirectory()) await mkdir(target, { recursive: true, mode: 0o700 });
      else if (info.isFile()) {
        await copyFile(path, target);
        await chmod(target, info.mode & 0o755);
      } else throw new PinnedRuntimeError(`Unsupported package entry: ${path}`);
    },
    ...(skip === undefined ? [] : [{ skip }])
  );
}

interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Where Node finds a dependency from a directory: the nearest `node_modules` that holds it. */
async function resolveDependency(from: string, name: string): Promise<string | undefined> {
  for (let directory = from; ; directory = dirname(directory)) {
    if (basename(directory) !== 'node_modules') {
      const candidate = join(directory, 'node_modules', name);
      if (await pathPresent(join(candidate, 'package.json'))) return realpath(candidate);
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * Copies a package's production dependency graph beside its copy, each package
 * where Node resolves it from there. A package inside the source keeps its path;
 * one hoisted above it, as an install in a project's `node_modules` leaves them,
 * keeps its path from the directory that `node_modules` belongs to.
 */
async function copyDependencies(source: string, destination: string): Promise<void> {
  const installRoot = source.includes(`${sep}node_modules${sep}`)
    ? source.slice(0, source.indexOf(`${sep}node_modules${sep}`))
    : source;
  const placed = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8')
    ) as Manifest;
    const names = Object.keys({
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }).sort();
    for (const name of names) {
      const found = await resolveDependency(directory, name);
      if (found === undefined || placed.has(found)) continue;
      const inside = relative(source, found);
      const path = inside.startsWith('..') || inside === '' ? relative(installRoot, found) : inside;
      if (!path.startsWith(`node_modules${sep}`))
        throw new PinnedRuntimeError(
          `Dependency ${name} at ${found} is outside the install it belongs to, so it cannot be copied`
        );
      placed.set(found, path);
      await copyTree(found, join(destination, path), (entry) => entry === 'node_modules');
      await visit(found);
    }
  };
  await visit(source);
}

/** Asks a copied build for its own executor fingerprint, under the coordinator's Node. */
async function probeExecutor(
  namespace: string,
  root: string,
  runtime: CoordinatorConfig['runtime']
): Promise<string> {
  try {
    const { stdout } = await run(runtime.node, [join(root, CLI_ENTRY), 'prove', 'measure-tools'], {
      env: { ...runtime.environment, NODE_DISABLE_COMPILE_CACHE: '1' },
      cwd: namespace,
      maxBuffer: 1 << 20,
    });
    const measured = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { executor?: unknown };
    if (typeof measured.executor !== 'string' || !/^[0-9a-f]{64}$/.test(measured.executor))
      throw new Error('it reported no executor fingerprint');
    return measured.executor;
  } catch (error) {
    throw new PinnedRuntimeError(
      `The copied FireForge at ${root} did not run under ${runtime.node}: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
      { cause: error }
    );
  }
}

/** The version a package states, with its stamped build identity. */
async function packageVersion(root: string): Promise<string> {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  return formatVersionWithIdentity(version, readBuildInfoFile(root));
}

/** Refuses a directory that is not a built FireForge package. */
async function assertBuiltPackage(source: string): Promise<void> {
  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as typeof manifest;
  } catch (error) {
    throw new PinnedRuntimeError(`${source} holds no readable package.json`, { cause: error });
  }
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    !isFireForgePackageMetadata({
      name: manifest.name,
      version: manifest.version,
      bin: manifest.bin,
    })
  )
    throw new PinnedRuntimeError(`${source} is not a FireForge package`);
  for (const entry of [SUPERVISOR_ENTRY, CLI_ENTRY])
    if (!(await pathPresent(join(source, entry))))
      throw new PinnedRuntimeError(
        `${source} has no ${entry}; build it first (npm run build), or name an installed FireForge package`
      );
}

/**
 * Removes builds no record names, except the one a live supervisor still runs
 * from, and staging a crash left behind.
 */
async function pruneRuntimes(
  namespace: string,
  keep: readonly string[],
  running: string | undefined
): Promise<void> {
  const names = await readdir(runtimeRoot(namespace)).catch(() => [] as string[]);
  const live = running === undefined ? undefined : await realpath(running).catch(() => running);
  for (const name of names) {
    if (name === 'current.json' || keep.includes(name)) continue;
    const path = join(runtimeRoot(namespace), name);
    if (live !== undefined && live === (await realpath(path).catch(() => path))) continue;
    if (/^[0-9a-f]{16}$/.test(name) || name.startsWith('.staging-')) await removeTree(path);
  }
}

/**
 * Copies a built FireForge package into the namespace, verifies the copy and
 * records it as the build every supervisor start runs. The record is replaced
 * in one rename, so a start reads either build, never a mix. The build it
 * replaces stays as `previous`; older ones are removed.
 *
 * @param options.from - The package directory to copy
 * @param options.running - The package a live supervisor runs from, which stays
 * @throws {PinnedRuntimeError} When the package is not built, will not copy, or its copy does not verify
 */
export async function pinRuntime(
  namespace: string,
  options: { from: string; runtime: CoordinatorConfig['runtime']; running?: string }
): Promise<{ record: PinnedRuntimeRecord; changed: boolean }> {
  const source = await realpath(resolve(options.from));
  await assertBuiltPackage(source);
  const staging = join(runtimeRoot(namespace), `.staging-${randomUUID()}`);
  try {
    await copyTree(join(source, 'dist'), join(staging, 'dist'), skipShipped);
    for (const directory of ['runtime', 'templates'])
      if (await pathPresent(join(source, directory)))
        await copyTree(join(source, directory), join(staging, directory));
    await copyFile(join(source, 'package.json'), join(staging, 'package.json'));
    await copyDependencies(source, staging);
    if ((await dependencyGraphIdentity(staging)) !== (await dependencyGraphIdentity(source)))
      throw new PinnedRuntimeError(
        `The copy of ${source}'s production dependencies does not resolve to the same packages`
      );
    const digest = await runtimeDigest(staging);
    const id = digest.slice(0, 16);
    const root = pinnedPackage(namespace, { id });
    if (await pathPresent(root)) await removeTree(staging);
    else await rename(staging, root);
    if ((await runtimeDigest(root)) !== digest)
      throw new PinnedRuntimeError(`The pinned runtime at ${root} changed while it was recorded`);
    const earlier = await readPinnedRuntime(namespace);
    const build: PinnedBuild = {
      id,
      version: await packageVersion(root),
      digest,
      executorDigest: await probeExecutor(namespace, root, options.runtime),
      protocol: COORDINATOR_PROTOCOL,
      source,
      pinnedAt: new Date().toISOString(),
    };
    const changed = earlier?.current.digest !== digest;
    const previous =
      earlier === undefined ? undefined : changed ? earlier.current : earlier.previous;
    const record: PinnedRuntimeRecord = {
      schemaVersion: 1,
      current: build,
      ...(previous === undefined ? {} : { previous }),
    };
    await writeDurable(recordPath(namespace), record);
    await pruneRuntimes(
      namespace,
      [build.id, ...(previous === undefined ? [] : [previous.id])],
      options.running
    );
    return { record, changed };
  } finally {
    await removeTree(staging).catch(() => undefined);
  }
}

/**
 * Makes the previous pinned build current again, after verifying its bytes.
 *
 * @throws {PinnedRuntimeError} When there is no previous build, or it no longer verifies
 */
export async function pinPreviousRuntime(namespace: string): Promise<PinnedRuntimeRecord> {
  const record = await readPinnedRuntime(namespace);
  if (record?.previous === undefined)
    throw new PinnedRuntimeError(
      'This host has no previous pinned FireForge to return to; pin one with: fireforge host upgrade --from <package directory>'
    );
  await verifyPinnedBuild(namespace, record.previous);
  const swapped: PinnedRuntimeRecord = {
    schemaVersion: 1,
    current: { ...record.previous, pinnedAt: new Date().toISOString() },
    previous: record.current,
  };
  await writeDurable(recordPath(namespace), swapped);
  return swapped;
}

/** How a supervisor or a measuring CLI starts from the pinned build, verified first. */
export interface PinnedEntry {
  build: PinnedBuild;
  root: string;
  supervisor: string;
  cli: string;
}

/**
 * The verified pinned build's entry points, or undefined when the host pins none.
 *
 * @throws {PinnedRuntimeError} When a pinned build exists and does not verify
 */
export async function pinnedEntry(namespace: string): Promise<PinnedEntry | undefined> {
  const record = await readPinnedRuntime(namespace);
  if (record === undefined) return undefined;
  const root = await verifyPinnedBuild(namespace, record.current);
  return {
    build: record.current,
    root,
    supervisor: join(root, SUPERVISOR_ENTRY),
    cli: join(root, CLI_ENTRY),
  };
}
