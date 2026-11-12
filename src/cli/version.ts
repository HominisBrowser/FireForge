// SPDX-License-Identifier: EUPL-1.2
/**
 * Which FireForge this is: the package's root directory, its version, and the
 * build identity `--version` reports as `<semver>+g<commit>[.dirty[.<hash>]]`.
 *
 * In a git checkout the identity comes from git itself, so a stale build stamp
 * never wins. An installed package reads `dist/build-info.json`, stamped at
 * build time. When neither yields an identity the plain version is reported.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { invariant } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { readJsonIfExists } from '../kernel/json.js';
import { run } from '../kernel/process/index.js';
import { s, type Schema } from '../kernel/schema.js';

const PackageManifest = s.object(
  {
    version: s.string().optional(),
    bin: s.union(s.string(), s.record(s.string())).optional(),
    bugs: s.object({ url: s.string().optional() }, { unknownKeys: 'keep' }).optional(),
  },
  { unknownKeys: 'keep' }
);

const nullable = <T>(schema: Schema<T>): Schema<T | null | undefined, true> =>
  s.union(schema, s.literal(null)).optional();

const BuildInfo = s.object(
  {
    shortCommit: nullable(s.string()),
    dirty: nullable(s.boolean()),
    dirtyHash: nullable(s.string()),
  },
  { unknownKeys: 'keep' }
);

/** The source a build was made from. */
export interface BuildIdentity {
  shortCommit: string;
  dirty: boolean;
  /** Hash of the uncommitted content, known only for a stamped build. */
  dirtyHash?: string;
}

interface PackageInfo {
  path: string;
  version: string;
  issuesUrl: string | undefined;
}

let root: Promise<PackageInfo> | undefined;

async function locate(): Promise<PackageInfo> {
  // Works from the source tree and from the compiled one: the root is the
  // nearest directory whose package.json provides the `fireforge` executable.
  for (let current = dirname(fileURLToPath(import.meta.url)); ; current = dirname(current)) {
    const manifest = await readJsonIfExists(join(current, 'package.json'), PackageManifest);
    if (typeof manifest?.bin === 'object' && manifest.bin['fireforge'] !== undefined) {
      return {
        path: current,
        version: manifest.version ?? '0.0.0',
        issuesUrl: manifest.bugs?.url,
      };
    }
    invariant(current !== dirname(current), 'the fireforge package root exists');
  }
}

/** The directory FireForge is installed in, which holds `templates/`. */
export async function packageRoot(): Promise<string> {
  root ??= locate();
  return (await root).path;
}

/** The package's semantic version. */
export async function packageVersion(): Promise<string> {
  root ??= locate();
  return (await root).version;
}

/** Where the package asks for bug reports, when it says. */
export async function issuesUrl(): Promise<string | undefined> {
  root ??= locate();
  return (await root).issuesUrl;
}

/**
 * Formats a version with its build identity. Every segment stays valid
 * semver build metadata.
 *
 * @param version - The semantic version
 * @param identity - The build identity, when known
 */
export function formatVersion(version: string, identity: BuildIdentity | undefined): string {
  if (identity === undefined) return version;
  const base = `${version}+g${identity.shortCommit}`;
  if (!identity.dirty) return base;
  return identity.dirtyHash === undefined ? `${base}.dirty` : `${base}.dirty.${identity.dirtyHash}`;
}

async function buildIdentity(packagePath: string): Promise<BuildIdentity | undefined> {
  if (await exists(join(packagePath, '.git'))) {
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: packagePath });
    const commit = head.stdout.trim();
    if (head.exitCode !== 0 || !/^[0-9a-f]{7,40}$/.test(commit)) return undefined;
    const status = await run('git', ['status', '--porcelain'], { cwd: packagePath });
    if (status.exitCode !== 0) return undefined;
    return { shortCommit: commit.slice(0, 12), dirty: status.stdout.length > 0 };
  }
  const info = await readJsonIfExists(join(packagePath, 'dist', 'build-info.json'), BuildInfo);
  if (typeof info?.shortCommit !== 'string' || info.shortCommit === '') return undefined;
  return {
    shortCommit: info.shortCommit,
    dirty: info.dirty === true,
    ...(typeof info.dirtyHash === 'string' ? { dirtyHash: info.dirtyHash } : {}),
  };
}

/** The string `fireforge --version` prints. Never throws: it degrades to the plain version. */
export async function cliVersion(): Promise<string> {
  const version = await packageVersion();
  const identity = await buildIdentity(await packageRoot()).catch(() => undefined);
  return formatVersion(version, identity);
}
