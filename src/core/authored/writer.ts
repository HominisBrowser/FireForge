// SPDX-License-Identifier: EUPL-1.2
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { ProjectPaths } from '../../types/config.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { getProjectPaths, loadConfig } from '../config.js';
import { mapDeployedComponentSources } from '../furnace-composed-source.js';
import { validateFurnaceConfig } from '../furnace-config.js';
import {
  canonicalJson,
  digest,
  pristineRepositoryFor,
  readSourceBlob,
  sourceBlobId,
  sourceGit,
} from './git.js';
import { assertNoSourceAliases, assertSourcePath } from './paths.js';
import { readPristineEntry, requireAuthoredConfig } from './provider.js';
import type { SourceFileMode, UpstreamDeclaration } from './types.js';
import {
  authoredMutationPublished,
  authoredMutationWillPublish,
  authoredStagingFile,
  projectRootAbove,
  withAuthoredPathLock,
} from './write-lock.js';

/** Authoring commands address tracked source; runtime commands keep engine paths. */
export async function authoringProjectPaths(projectRoot: string): Promise<ProjectPaths> {
  const paths = getProjectPaths(projectRoot);
  if (!(await optionalBytes(join(projectRoot, 'fireforge.json')))) return paths;
  const config = await loadConfig(projectRoot);
  if (!config.sources) return paths;
  const sources = requireAuthoredConfig(config);
  return { ...paths, engine: join(projectRoot, sources.root) };
}

/** Resolve project-owned documentation beside a possibly nested authored source root. */
export async function authoringProjectRoot(engineDir: string): Promise<string> {
  return (await projectRootAbove(engineDir)) ?? dirname(engineDir);
}

async function optionalBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Validate a first-touch declaration against actual pristine content. */
export async function declareAuthoredOverride(
  projectRoot: string,
  path: string,
  options: {
    component: string;
    classification: 'registration' | 'exception';
    adr?: string;
    delete?: boolean;
    /** Delete an uncommitted postimage that re-declaring a tombstone would otherwise refuse. */
    discard?: boolean;
    pristineRepository?: string;
  }
): Promise<UpstreamDeclaration> {
  return withAuthoredPathLock(projectRoot, path, (root) =>
    declareAuthoredOverrideUnlocked(root, path, options)
  );
}

async function declareAuthoredOverrideUnlocked(
  projectRoot: string,
  path: string,
  options: Parameters<typeof declareAuthoredOverride>[2]
): Promise<UpstreamDeclaration> {
  assertSourcePath(path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.component))
    throw new GeneralError('authored-invalid-component');
  if (options.classification === 'exception' && !options.adr)
    throw new GeneralError('authored-adr-required');
  if (options.adr) {
    assertSourcePath(options.adr);
    if (!(await optionalBytes(join(projectRoot, options.adr))))
      throw new GeneralError('authored-adr-missing');
  }
  const config = await loadConfig(projectRoot);
  const sources = requireAuthoredConfig(config);
  const pristineRepository = pristineRepositoryFor(projectRoot, options.pristineRepository);
  const pristine = await readPristineEntry(pristineRepository, sources.pristineCommit, path);
  if (!pristine) throw new GeneralError(`override-base-missing: ${path}`);
  const furnaceBytes = await optionalBytes(join(projectRoot, 'furnace.json'));
  const generated = furnaceBytes
    ? (
        await mapDeployedComponentSources(
          projectRoot,
          validateFurnaceConfig(JSON.parse(furnaceBytes.toString('utf8')) as unknown),
          { refuseCollisions: true }
        )
      ).has(path)
    : false;
  if (generated && options.delete)
    throw new GeneralError(`authored-delete-has-generated-source: ${path}`);
  const declaration: UpstreamDeclaration = {
    schemaVersion: 1,
    kind: options.delete ? 'delete' : 'override',
    path,
    base: {
      pin: digest({ firefox: config.firefox, commit: sources.pristineCommit }),
      commit: sources.pristineCommit,
      blob: pristine.blob,
      mode: pristine.mode,
    },
    component: options.component,
    classification: options.classification,
    ...(options.adr ? { adr: options.adr } : {}),
  };
  const destination = `${sources.metadataRoot}/overrides/${path}.json`;
  const source = `${sources.root}/${path}`;
  await assertNoSourceAliases(projectRoot, destination);
  await assertNoSourceAliases(projectRoot, source);
  const existing = await optionalBytes(join(projectRoot, destination));
  if (
    existing &&
    canonicalJson(JSON.parse(existing.toString('utf8')) as unknown) !== canonicalJson(declaration)
  )
    throw new GeneralError(`authored-declaration-exists: ${path}`);
  const content = await optionalBytes(join(projectRoot, source));
  if (!existing && content)
    throw new GeneralError(
      `authored-postimage-undeclared: ${source} already exists without a declaration. Move it aside, run "fireforge authored override ${path}" to seed the pristine bytes, then reapply the edit.`
    );
  if (existing && content && options.delete && !options.discard)
    throw new GeneralError(
      `authored-delete-has-postimage: ${source} exists under a tombstone. Remove it, or pass --discard.`
    );
  await mkdir(dirname(join(projectRoot, destination)), { recursive: true });
  await authoredMutationWillPublish(projectRoot, [destination, source]);
  await publishFile(
    projectRoot,
    destination,
    Buffer.from(canonicalJson(declaration) + '\n'),
    '100644'
  );
  if (options.delete) {
    await rm(join(projectRoot, source), { force: true });
    await authoredMutationPublished(projectRoot, [source]);
  } else if (!content && !generated) {
    await mkdir(dirname(join(projectRoot, source)), { recursive: true });
    await publishFile(
      projectRoot,
      source,
      await readSourceBlob(pristineRepository, pristine.blob),
      pristine.mode
    );
  }
  return declaration;
}

/** An uncommitted postimage is work a restore would lose; committed or pristine bytes are not. */
async function assertPostimageExpendable(
  projectRoot: string,
  source: string,
  declarationBytes: Buffer
): Promise<void> {
  const bytes = await optionalBytes(join(projectRoot, source));
  if (!bytes) return;
  const declared = JSON.parse(declarationBytes.toString('utf8')) as UpstreamDeclaration;
  const format = declared.base.blob.length === 40 ? 'sha1' : 'sha256';
  const blob = sourceBlobId(bytes, format);
  if (blob === declared.base.blob) return;
  const committed = (await sourceGit(projectRoot, ['ls-tree', '-z', 'HEAD', '--', source]))
    .toString('utf8')
    .split(/\s/)[2];
  if (committed !== blob)
    throw new GeneralError(
      `authored-postimage-uncommitted: ${source} has uncommitted edits a restore would lose. Commit them, or pass --discard.`
    );
}

/** Removing a declaration means restore upstream, never delete upstream. */
export async function removeAuthoredOverride(
  projectRoot: string,
  path: string,
  options: { discard?: boolean } = {}
): Promise<void> {
  return withAuthoredPathLock(projectRoot, path, async (root) => {
    assertSourcePath(path);
    const sources = requireAuthoredConfig(await loadConfig(root));
    const declaration = await optionalBytes(
      join(root, sources.metadataRoot, 'overrides', `${path}.json`)
    );
    if (declaration && !options.discard)
      await assertPostimageExpendable(root, `${sources.root}/${path}`, declaration);
    await removeAuthoredOverrideUnlocked(root, path);
  });
}

/** Internal removal boundary: caller owns the canonical root/path lock. */
export async function removeAuthoredOverrideUnlocked(
  projectRoot: string,
  path: string
): Promise<void> {
  assertSourcePath(path);
  const sources = requireAuthoredConfig(await loadConfig(projectRoot));
  const declaration = `${sources.metadataRoot}/overrides/${path}.json`;
  await assertNoSourceAliases(projectRoot, declaration);
  if (!(await optionalBytes(join(projectRoot, declaration))))
    throw new GeneralError(`authored-declaration-missing: ${path}`);
  await assertNoSourceAliases(projectRoot, `${sources.root}/${path}`);
  await authoredMutationWillPublish(projectRoot, [`${sources.root}/${path}`, declaration]);
  await rm(join(projectRoot, sources.root, path), { force: true });
  await authoredMutationPublished(projectRoot, [`${sources.root}/${path}`]);
  await rm(join(projectRoot, declaration));
  await authoredMutationPublished(projectRoot, [declaration]);
}

/** A sanctioned writer may alter created files or already declared upstream overrides. */
export async function writeAuthoredSourceFile(
  projectRoot: string,
  path: string,
  bytes: Buffer,
  options: {
    mode?: SourceFileMode;
    expected?: Buffer | null;
    pristineRepository?: string;
  } = {}
): Promise<void> {
  return withAuthoredPathLock(projectRoot, path, (root) =>
    writeAuthoredSourceFileUnlocked(root, path, bytes, options)
  );
}

async function writeAuthoredSourceFileUnlocked(
  projectRoot: string,
  path: string,
  bytes: Buffer,
  options: NonNullable<Parameters<typeof writeAuthoredSourceFile>[3]>
): Promise<void> {
  assertSourcePath(path);
  const config = await loadConfig(projectRoot);
  const sources = requireAuthoredConfig(config);
  const pristineRepository = pristineRepositoryFor(projectRoot, options.pristineRepository);
  const pristine = await readPristineEntry(pristineRepository, sources.pristineCommit, path);
  if (pristine) {
    const metadata = `${sources.metadataRoot}/overrides/${path}.json`;
    await assertNoSourceAliases(projectRoot, metadata);
    const raw = await optionalBytes(join(projectRoot, metadata));
    if (!raw)
      throw new GeneralError(
        `authored-declaration-required: declare the upstream override for ${path} first`
      );
    const declaration = JSON.parse(raw.toString('utf8')) as UpstreamDeclaration;
    if (
      declaration.kind !== 'override' ||
      declaration.path !== path ||
      declaration.base.commit !== sources.pristineCommit ||
      declaration.base.pin !==
        digest({ firefox: config.firefox, commit: sources.pristineCommit }) ||
      declaration.base.blob !== pristine.blob ||
      declaration.base.mode !== pristine.mode
    )
      throw new GeneralError(`override-base-mismatch: ${path}`);
  }
  const target = `${sources.root}/${path}`;
  await assertNoSourceAliases(projectRoot, target);
  const current = await optionalBytes(join(projectRoot, target));
  if (
    options.expected !== undefined &&
    !(
      (options.expected === null && current === undefined) ||
      (options.expected !== null && current?.equals(options.expected))
    )
  )
    throw new GeneralError(`authored-source-moved: ${path}`);
  let mode = options.mode;
  if (!mode) {
    try {
      mode = ((await lstat(join(projectRoot, target))).mode & 0o111) !== 0 ? '100755' : '100644';
    } catch (error: unknown) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      mode = pristine?.mode ?? '100644';
    }
  }
  await authoredMutationWillPublish(projectRoot, [target]);
  await publishFile(projectRoot, target, bytes, mode);
}

async function publishFile(
  projectRoot: string,
  target: string,
  bytes: Buffer,
  mode: SourceFileMode
): Promise<void> {
  const temporary = await authoredStagingFile(projectRoot);
  await mkdir(dirname(join(projectRoot, target)), { recursive: true });
  try {
    await writeFile(temporary, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
    await rename(temporary, join(projectRoot, target));
    await authoredMutationPublished(projectRoot, [target]);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Registration helpers may be called with an engine path by Furnace. */
export async function routedAuthoringPath(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  const directory = await projectRootAbove(dirname(absolute));
  if (directory === undefined) return absolute;
  const config = await loadConfig(directory);
  if (!config.sources) return absolute;
  const sources = requireAuthoredConfig(config);
  const engine = join(directory, 'engine');
  if (!absolute.startsWith(engine + sep)) return absolute;
  const path = relative(engine, absolute).split(sep).join('/');
  assertSourcePath(path);
  await assertNoSourceAliases(directory, `${sources.root}/${path}`);
  return join(directory, sources.root, path);
}
