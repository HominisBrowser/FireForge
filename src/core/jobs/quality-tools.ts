// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FireForgeConfig } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { getPackageRoot } from '../../utils/package-root.js';
import { resolvedNodeToolIdentity } from '../node-tool-identity.js';
import { resolvePatchLintPrettier } from '../patch-lint-prettier.js';
import { boundPrettierConfiguration } from '../prettier-bound-config.js';
import { declaredCaches } from './dependency-caches.js';
import { executorFingerprint } from './evidence.js';
import { gitToolIdentity } from './git-tools.js';
import { readAdmittedSnapshot } from './guard.js';
import { readJson, writeDurable } from './store.js';
import { fileDigest, forgetFileDigests, toolTreeDigest, treeStatSignature } from './tool-files.js';

async function optionalRoot(root: string): Promise<string[]> {
  try {
    return [await realpath(root)];
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * The digest of what one installed tree reads, by every byte. A package is known
 * by its path and bytes, whatever its manifest says: Firefox's own tree holds
 * packages with no `name`. Dot entries other than `.bin` are caches and
 * bookkeeping Node cannot resolve.
 */
async function installedToolBytes(root: string, aliases: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (path: string, label: string): Promise<void> => {
    hash.update(label).update(await toolTreeDigest(path, { aliases }));
  };
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith('.') && name !== '.bin') continue;
    const path = join(root, name);
    if (name.startsWith('@') && (await lstat(path)).isDirectory())
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), `${name}/${child}`);
    else await visit(path, name);
  }
  return hash.digest('hex');
}

/** Where a root keeps what its installed trees last hashed to, by stat signature. */
const inventoryRecord = (projectRoot: string): string =>
  join(projectRoot, '.fireforge', 'quality-inventory.json');

/**
 * An installed tree's digest, read again only when its stat signature moved: a
 * real tree is half a gigabyte and every process asks. A rewrite that restores
 * size and mtime gets past the signature, which is what `full` is for.
 */
async function installedToolInventory(
  projectRoot: string,
  root: string,
  aliases: readonly string[],
  full: boolean
): Promise<string> {
  try {
    await access(root);
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
  const signature = await treeStatSignature([root], { followLinks: true });
  const path = inventoryRecord(projectRoot);
  const recorded: Record<string, { signature: string; digest: string }> = await readJson<
    Record<string, { signature: string; digest: string }>
  >(path).catch(() => ({}));
  const known = recorded[root];
  if (!full && known?.signature === signature) return known.digest;
  const digest = await installedToolBytes(root, aliases);
  // Only a shortcut for the next process: a root that cannot record it just hashes again.
  await writeDurable(path, { ...recorded, [root]: { signature, digest } }).catch(() => undefined);
  return digest;
}

type RootConfig = Pick<FireForgeConfig, 'slots'> & { patchLint?: { prettier?: unknown } };

/** The parts of the config this root holds that decide which tools it reads. */
async function rootConfig(projectRoot: string): Promise<RootConfig> {
  try {
    return JSON.parse(await readFile(join(projectRoot, 'fireforge.json'), 'utf8')) as RootConfig;
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return {};
    throw error;
  }
}

/** The host's part of the identity: what no project root can change. */
async function hostToolRecords(git?: { digest: string }): Promise<unknown[]> {
  const consumer = fileURLToPath(new URL('../typecheck.js', import.meta.url));
  return [
    ['executor-code-and-assets', await executorFingerprint()],
    ['git-runtime', (git ?? (await gitToolIdentity())).digest],
    ['node-runtime', await fileDigest(await realpath(process.execPath))],
    ...(await Promise.all(
      ['typescript', 'eslint', 'prettier'].map(async (name) => [
        'runtime-import',
        name,
        await resolvedNodeToolIdentity(name, consumer),
      ])
    )),
  ];
}

/** Actual quality imports, all installed project/engine plugins/assets, and their local config inputs. */
async function qualityToolDigest(
  projectRoot: string,
  host: readonly unknown[],
  full = false
): Promise<string> {
  const engine = join(projectRoot, 'engine');
  const config = await rootConfig(projectRoot);
  const formatter =
    config.patchLint?.prettier !== 'off'
      ? await resolvePatchLintPrettier(engine, projectRoot)
      : undefined;
  const roots = [getPackageRoot(), projectRoot, engine];
  const records: unknown[] = [...host];
  for (const [index, root] of roots.entries()) {
    if (index > 0)
      records.push([
        index,
        'installed-tools',
        await installedToolInventory(
          projectRoot,
          join(root, 'node_modules'),
          [
            getPackageRoot(),
            ...(await optionalRoot(projectRoot)),
            ...(await optionalRoot(engine)),
            // A feedback view links its `node_modules` to the checkout's, and a
            // `.bin` entry resolves to a package beside it there.
            ...(await optionalRoot(join(root, 'node_modules'))),
          ],
          full
        ),
      ]);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      names = [];
    }
    const configs = names
      .filter((name) =>
        /^(?:\.prettier(?:rc(?:\..*)?|ignore)|prettier\.config\..*|\.eslintrc(?:\..*)?|eslint\.config\..*|\.eslintignore|\.editorconfig|package\.json|(?:package-lock|npm-shrinkwrap)\.json)$/.test(
          name
        )
      )
      .sort();
    for (const name of configs) records.push([index, name, await toolTreeDigest(join(root, name))]);
  }
  // The two `node_modules` above are always read; other declared trees join them.
  for (const { target } of declaredCaches(config))
    if (target !== 'node_modules' && target !== 'engine/node_modules')
      records.push([
        'dependency-cache',
        target,
        // A `.bin` entry resolves to a package beside it in the same tree.
        await installedToolInventory(
          projectRoot,
          join(projectRoot, target),
          await optionalRoot(join(projectRoot, target)),
          full
        ),
      ]);
  if (formatter) {
    const bounded = await boundPrettierConfiguration(engine, projectRoot, []);
    for (const path of bounded.inputs)
      records.push([
        'formatter-config',
        path.startsWith(projectRoot) ? path.slice(projectRoot.length) : path,
        await toolTreeDigest(path),
      ]);
    records.push([
      'formatter-options',
      bounded.args.map((arg) =>
        arg.startsWith(projectRoot) ? arg.slice(projectRoot.length) : arg
      ),
    ]);
  }
  if (formatter)
    records.push(['actual-formatter', await toolTreeDigest(await realpath(formatter.command))]);
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

/**
 * Measures the tools now: what a long-lived supervisor needs to notice one
 * changing under it. Installed trees go by stat signature unless `full`, as a
 * final gate asks, and tool files are read only when their stamps moved. A caller
 * holding this moment's Git identity can pass it.
 */
export async function qualityToolIdentity(
  projectRoot: string,
  git?: { digest: string },
  options: { full?: boolean } = {}
): Promise<string> {
  if (options.full === true) forgetFileDigests();
  return qualityToolDigest(projectRoot, await hostToolRecords(git), options.full === true);
}

let hostSnapshot: Promise<unknown[]> | undefined;
const snapshots = new Map<string, Promise<string>>();
/** Reuse one immutable tool snapshot within a CLI process, never across admitted phases. */
export function qualityToolsOnce(root: string): Promise<string> {
  let value = snapshots.get(root);
  if (!value) {
    hostSnapshot ??= hostToolRecords();
    value = hostSnapshot.then((host) => qualityToolDigest(root, host));
    snapshots.set(root, value);
  }
  return value;
}

/** Cache reuse uses live authenticated campaign identity; standalone commands compute actual current bytes. */
export async function cacheQualityIdentity(root: string): Promise<string> {
  if (process.env['FIREFORGE_JOB_TOKEN'] === undefined) return qualityToolsOnce(root);
  const admitted = await readAdmittedSnapshot(root);
  if (!admitted.qualityToolsDigest)
    throw new Error('Admitted phase has no qualified quality-tool identity');
  return admitted.qualityToolsDigest;
}
