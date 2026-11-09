// SPDX-License-Identifier: EUPL-1.2
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { PatchesManifest } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { loadConfig, loadState } from '../config.js';
import {
  composeComponentSource,
  type FurnaceDeployedSource,
  mapDeployedComponentSources,
} from '../furnace-composed-source.js';
import { validateFurnaceConfig } from '../furnace-config.js';
import { loadPatchesManifest } from '../patch-manifest.js';
import { parseDiffSections } from '../patch-parse.js';
import {
  canonicalJson,
  digest,
  isObjectId,
  pristineRepositoryFor,
  readSourceBlobs,
  sourceGit,
  sourceRecord,
} from './git.js';
import { AUTHORED_MERGE_DRIVER } from './merge.js';
import { type PathImage, verifyMigration } from './migrate-verify.js';
import { assertNoSourceAliases, assertSourceMode, assertSourcePath } from './paths.js';
import { PRISTINE_PIN_FILE } from './pristine.js';
import { readPristineEntries } from './provider.js';
import type { AuthoredSourceConfig, CapturedInput, UpstreamDeclaration } from './types.js';

export interface LegacyMigrationResult {
  paths: number;
  overrides: number;
  deleted: number;
  generated: string[];
  sources: AuthoredSourceConfig;
  /** Where the pin came from: an explicit commit, an archive donor, the recorded base, or donor HEAD. */
  pinSource: 'explicit' | 'archive-donor' | 'recorded-base' | 'donor-head';
  /** Another host can rebuild this pin's donor from the Firefox archive alone. */
  pinReproducible: boolean;
  /** Present after `verify`: every queue path compared with the materialized overlay. */
  verified?: { paths: number };
}

const SOURCE_ATTRIBUTES = `* -text\n* merge=${AUTHORED_MERGE_DRIVER}\n`;

async function readQueue(
  root: string,
  manifest: PatchesManifest
): Promise<{
  patches: { name: string; body: Buffer }[];
  owners: Map<string, string[]>;
  affected: Set<string>;
}> {
  const patches: { name: string; body: Buffer }[] = [];
  const owners = new Map<string, string[]>();
  const affected = new Set<string>();
  for (const row of [...manifest.patches].sort(
    (a, b) => a.order - b.order || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
  )) {
    assertSourcePath(row.filename);
    const path = `patches/${row.filename}`;
    await assertNoSourceAliases(root, path);
    const body = await readFile(join(root, path));
    patches.push({ name: row.filename, body });
    for (const section of parseDiffSections(body.toString('utf8'))) {
      for (const path of new Set([section.sourcePath, section.targetPath])) {
        assertSourcePath(path);
        affected.add(path);
        const list = owners.get(path) ?? [];
        if (!list.includes(row.filename)) list.push(row.filename);
        owners.set(path, list);
      }
    }
  }
  return { patches, owners, affected };
}

async function migratePath(options: {
  path: string;
  pathOwners: readonly string[];
  pristine: CapturedInput | undefined;
  staging: string;
  destination: string;
  sources: AuthoredSourceConfig;
  config: FireForgeConfig;
  pin: string;
  commit: string;
  isGenerated: boolean;
}): Promise<{ paths: number; overrides: number; deleted: number }> {
  const {
    path,
    pathOwners,
    pristine,
    staging,
    destination,
    sources,
    config,
    pin,
    commit,
    isGenerated,
  } = options;
  let pathCount = 0;
  let overrides = 0;
  let deleted = 0;
  let bytes: Buffer | undefined;
  let mode: '100644' | '100755' = '100644';
  try {
    const stat = await lstat(join(staging, path));
    if (!stat.isFile()) throw new GeneralError(`authored-invalid-kind: ${path}`);
    bytes = await readFile(join(staging, path));
    mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  assertSourceMode(mode);
  if (bytes && !isGenerated) {
    const target = join(destination, sources.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    await chmod(target, mode === '100755' ? 0o755 : 0o644);
    pathCount++;
  }
  if (pristine) {
    if (pathOwners.length !== 1)
      throw new GeneralError(
        `authored-migration-ownership-ambiguous: ${path}; choose its stable upstream component explicitly`
      );
    const component = pathOwners[0] ?? '';
    const reserved = config.patchPolicy?.reservedRanges
      ?.flatMap((range) => range.allowed)
      .find((entry) => entry.filename === component);
    const regular = (config.patchPolicy?.upstreamAllowlist ?? []).some((entry) =>
      matchesAnyGlob(path, [typeof entry === 'string' ? entry : entry.path])
    );
    if (!reserved?.adr && !regular && config.patchPolicy)
      throw new GeneralError(`authored-migration-policy-unmapped: ${path}`);
    const declaration: UpstreamDeclaration = {
      schemaVersion: 1,
      kind: bytes ? 'override' : 'delete',
      path,
      base: { pin, commit, blob: pristine.blob, mode: pristine.mode },
      component,
      classification: reserved?.adr ? 'exception' : 'registration',
      ...(reserved?.adr ? { adr: reserved.adr } : {}),
    };
    const target = join(destination, sources.metadataRoot, 'overrides', `${path}.json`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, canonicalJson(declaration) + '\n');
    overrides++;
    if (!bytes) deleted++;
  }
  return { paths: pathCount, overrides, deleted };
}

async function writeMigrationMetadata(options: {
  root: string;
  destination: string;
  sources: AuthoredSourceConfig;
  config: FireForgeConfig;
  manifestBytes: Buffer;
  manifest: PatchesManifest;
  cutoverMap: Record<string, readonly string[]>;
}): Promise<void> {
  const { root, destination, sources, config, manifestBytes, manifest, cutoverMap } = options;
  const provenance = createHash('sha256').update(manifestBytes).digest('hex');
  await mkdir(join(destination, sources.metadataRoot), { recursive: true });
  if (!(await readFile(join(root, 'patches', 'patches.json'))).equals(manifestBytes))
    throw new GeneralError(
      'authored-migration-input-moved: manifest changed during reconstruction'
    );
  await writeFile(
    join(destination, sources.metadataRoot, 'cutover-map.json'),
    canonicalJson({ schemaVersion: 1, frozen: true, provenance, paths: cutoverMap }) + '\n'
  );
  const exceptions = manifest.patches
    .filter((row) => (row.lintIgnore?.length ?? 0) > 0 || row.tier !== undefined)
    .map((row) => ({
      component: row.filename,
      paths: [...row.filesAffected].sort(),
      checks: row.lintIgnore ?? [],
      ...(row.tier ? { tier: row.tier } : {}),
      provenance,
    }));
  await writeFile(join(destination, sources.metadataRoot, 'legacy-manifest.json'), manifestBytes);
  await writeFile(
    join(destination, sources.metadataRoot, 'policy.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        status: 'pending-review',
        adr: null,
        legacyScopeDigest: digest(config.patchPolicy?.scopeRules ?? []),
        retireCreatedPatchBudgets: null,
        createdPatchBudgetReason: '',
        scopeRules: (config.patchPolicy?.scopeRules ?? []).map((rule, index) => ({
          legacyRule: digest({ index, rule }),
          decision: 'pending',
          reason: '',
          select: [],
          allow: rule.files,
        })),
      },
      null,
      2
    ) + '\n'
  );
  await writeFile(
    join(destination, sources.metadataRoot, 'waivers.json'),
    canonicalJson({ schemaVersion: 1, exceptions }) + '\n'
  );
  await mkdir(join(destination, sources.root), { recursive: true });
  await writeFile(join(destination, sources.root, '.gitattributes'), SOURCE_ATTRIBUTES);
  await writeFile(
    join(destination, 'fireforge.fragment.json'),
    JSON.stringify({ sources, test: { ...config.test, reapOrphans: 'owned' } }, null, 2) + '\n'
  );
}

/** The commit a donor imported from the archive of exactly this Firefox pin, if it is one. */
async function archiveDonorCommit(
  pristineRepository: string,
  firefox: FireForgeConfig['firefox']
): Promise<string | undefined> {
  let recorded: { firefox?: unknown; commit?: unknown };
  try {
    recorded = JSON.parse(
      await readFile(join(pristineRepository, PRISTINE_PIN_FILE), 'utf8')
    ) as typeof recorded;
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
  // The checksum names the archive; `candidate` only says where to fetch it from.
  const donor = recorded.firefox as Partial<FireForgeConfig['firefox']> | undefined;
  return typeof recorded.commit === 'string' &&
    donor?.version === firefox.version &&
    donor.product === firefox.product &&
    donor.sha256 === firefox.sha256
    ? recorded.commit
    : undefined;
}

/**
 * An archive donor's commit first, since any host can rebuild it. Then the recorded
 * base, which only this engine's history holds: donor HEAD may have moved past the
 * pristine commit the queue targets.
 */
async function resolveMigrationPin(
  root: string,
  pristineRepository: string,
  explicit: string | undefined,
  firefox: FireForgeConfig['firefox']
): Promise<{
  commit: string;
  pinSource: LegacyMigrationResult['pinSource'];
  reproducible: boolean;
}> {
  const archived = await archiveDonorCommit(pristineRepository, firefox);
  if (explicit !== undefined) {
    if (!isObjectId(explicit)) throw new GeneralError('authored-invalid-pristine-commit');
    return { commit: explicit, pinSource: 'explicit', reproducible: archived === explicit };
  }
  if (archived !== undefined) {
    return { commit: archived, pinSource: 'archive-donor', reproducible: true };
  }
  const recorded = (await loadState(root)).baseCommit;
  if (recorded === undefined) {
    const head = await sourceGit(pristineRepository, ['rev-parse', '--verify', 'HEAD']);
    return { commit: head.toString('utf8').trim(), pinSource: 'donor-head', reproducible: false };
  }
  try {
    await sourceGit(pristineRepository, ['rev-parse', '--verify', `${recorded}^{commit}`]);
  } catch {
    throw new GeneralError(
      `authored-migration-pin-mismatch: the recorded base commit ${recorded} is not in ${pristineRepository}; use a donor that holds it, or pass --pristine-commit`
    );
  }
  return { commit: recorded, pinSource: 'recorded-base', reproducible: false };
}

/** Seed the queue's paths with pristine bytes and apply every patch in a disposable repository. */
export async function replayQueue(options: {
  staging: string;
  pristineRepository: string;
  commit: string;
  affected: ReadonlySet<string>;
  patches: readonly { name: string; body: Buffer }[];
}): Promise<{
  pristineByPath: Map<string, CapturedInput>;
  pristineFiles: Map<string, PathImage>;
}> {
  const { staging, pristineRepository, commit, patches } = options;
  const affected = [...options.affected].sort();
  const pristineByPath = await readPristineEntries(pristineRepository, commit, affected);
  const blobs = await readSourceBlobs(
    pristineRepository,
    [...pristineByPath.values()].map((entry) => entry.blob)
  );
  const pristineFiles = new Map<string, PathImage>();
  for (const path of affected) {
    const pristine = pristineByPath.get(path);
    if (!pristine) continue;
    const bytes = blobs.get(pristine.blob);
    if (!bytes) throw new GeneralError(`authored-object-unavailable: ${path}`);
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await writeFile(join(staging, path), bytes, {
      mode: pristine.mode === '100755' ? 0o755 : 0o644,
    });
    pristineFiles.set(path, { mode: pristine.mode, bytes });
  }
  for (const patch of patches)
    await sourceGit(staging, ['apply', '--binary', '--whitespace=nowarn', '-'], patch.body);
  return { pristineByPath, pristineFiles };
}

/** A destination may only be absent or empty; it receives the finished overlay in one rename. */
async function publishMigration(temporaryOutput: string, destination: string): Promise<void> {
  try {
    await rmdir(destination);
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code !== 'ENOENT') throw new GeneralError('authored-migration-destination-not-empty');
  }
  await rename(temporaryOutput, destination);
}

/** Reconstruct the queue in a disposable fixture, never import live engine drift. */
export async function migrateLegacyQueue(options: {
  projectRoot: string;
  destination: string;
  pristineRepository?: string;
  pristineCommit?: string;
  /** Prove the overlay reconstructs the queue before publishing it. */
  verify?: boolean;
}): Promise<LegacyMigrationResult> {
  const root = resolve(options.projectRoot);
  const destination = resolve(options.destination);
  if (destination === root || destination.startsWith(root + '/'))
    throw new GeneralError('authored-migration-destination: use a separate disposable directory');
  const config = await loadConfig(root);
  const pristineRepository = pristineRepositoryFor(root, options.pristineRepository);
  const {
    commit,
    pinSource,
    reproducible: pinReproducible,
  } = await resolveMigrationPin(root, pristineRepository, options.pristineCommit, config.firefox);
  const sources: AuthoredSourceConfig = {
    schemaVersion: 1,
    mode: 'authored',
    root: 'src',
    metadataRoot: '.fireforge-sources',
    pristineCommit: commit,
  };
  const manifestBytes = await readFile(join(root, 'patches', 'patches.json'));
  const manifest = await loadPatchesManifest(join(root, 'patches'));
  if (!manifest) throw new GeneralError('authored-migration-manifest-missing');
  const { patches, owners, affected } = await readQueue(root, manifest);
  let furnace;
  try {
    furnace = validateFurnaceConfig(
      JSON.parse(await readFile(join(root, 'furnace.json'), 'utf8')) as unknown
    );
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  const generatedSources = furnace
    ? await mapDeployedComponentSources(root, furnace, { refuseCollisions: true })
    : new Map<string, FurnaceDeployedSource>();
  const generated = (path: string): boolean => generatedSources.has(path);
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-migrate-'));
  const staging = join(temporary, 'queue');
  await mkdir(staging);
  // A sibling of the destination, so a failure at any point leaves it untouched and retryable.
  const output = `${destination}.migrate-${randomUUID()}`;
  try {
    await mkdir(dirname(destination), { recursive: true });
    if ((await readdir(destination).catch(() => [])).length)
      throw new GeneralError('authored-migration-destination-not-empty');
    await mkdir(output);
    await sourceGit(staging, ['init', '-q']);
    const { pristineByPath, pristineFiles } = await replayQueue({
      staging,
      pristineRepository,
      commit,
      affected,
      patches,
    });
    for (const [path, source] of generatedSources) {
      const sourceBytes = await readFile(source.sourcePath);
      const bytes = source.fileName.endsWith('.css')
        ? Buffer.from(
            await composeComponentSource(
              sourceBytes.toString('utf8'),
              source.fileName,
              join(root, 'components/shared')
            )
          )
        : sourceBytes;
      const recorded = await readFile(join(staging, path)).catch(() => undefined);
      if (!recorded?.equals(bytes))
        throw new GeneralError(
          `authored-migration-generated-drift: ${path}; component source and recorded queue disagree`
        );
    }
    let pathCount = 0;
    let overrides = 0;
    let deleted = 0;
    const generatedPaths: string[] = [];
    const pin = digest({ firefox: config.firefox, commit });
    const cutoverMap = sourceRecord<readonly string[]>();
    for (const path of [...affected].sort()) {
      const pathOwners = owners.get(path) ?? [];
      cutoverMap[path] = pathOwners;
      const isGenerated = generated(path);
      if (isGenerated) generatedPaths.push(path);
      const pristine = pristineByPath.get(path);
      const written = await migratePath({
        path,
        pathOwners,
        pristine,
        staging,
        destination: output,
        sources,
        config,
        pin,
        commit,
        isGenerated,
      });
      pathCount += written.paths;
      overrides += written.overrides;
      deleted += written.deleted;
    }
    for (const patch of patches) {
      if (!(await readFile(join(root, 'patches', patch.name))).equals(patch.body))
        throw new GeneralError(
          'authored-migration-input-moved: queue changed during reconstruction'
        );
    }
    await writeMigrationMetadata({
      root,
      destination: output,
      sources,
      config,
      manifestBytes,
      manifest,
      cutoverMap,
    });
    const verified = options.verify
      ? await verifyMigration({
          root,
          overlay: output,
          staging,
          temporary,
          sources,
          config,
          pristineRepository,
          pristineFiles,
          affected,
        })
      : undefined;
    await publishMigration(output, destination);
    return {
      paths: pathCount,
      overrides,
      deleted,
      generated: generatedPaths,
      sources,
      pinSource,
      pinReproducible,
      ...(verified ? { verified } : {}),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}
