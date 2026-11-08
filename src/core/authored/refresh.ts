// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { FirefoxConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { validateConfig } from '../config-validate.js';
import { composeComponentSource } from '../furnace-composed-source.js';
import { stripExpandedFragments } from '../furnace-css-fragments.js';
import { composeCapturedFurnace, type GeneratedSource } from './generated.js';
import { canonicalJson, digest, pristineRepositoryFor, readSourceBlobs, sourceGit } from './git.js';
import { exportCapturedTree } from './materialize.js';
import { assertSourcePath } from './paths.js';
import {
  authenticateAuthoredSnapshot,
  readPristineRecords,
  requireAuthoredConfig,
} from './provider.js';
import { mergeRefreshImages, type RefreshImage } from './refresh-merge.js';
import type {
  AuthoredFile,
  AuthoredSnapshot,
  CapturedInput,
  UpstreamDeclaration,
} from './types.js';

export interface RefreshAuthoredOptions {
  snapshot: AuthoredSnapshot;
  destination: string;
  oldPristineRepository?: string;
  newPristineRepository: string;
  newPin: { firefox: FirefoxConfig; commit: string };
}

export interface AuthoredRefreshPath {
  path: string;
  outcome: 'clean' | 'retired' | 'conflict' | 'created';
  reason?: string;
  /** Proposal-relative files to resolve this conflict from: markers, or the sides of a binary one. */
  conflictFiles?: string[];
  output?: { sha256: string; mode: string };
}

export interface AuthoredRefreshProposal {
  schemaVersion: 1;
  sourceId: string;
  oldPin: AuthoredSnapshot['pin'];
  newPin: AuthoredSnapshot['pin'];
  destination: string;
  /** Conflicted proposals cannot be captured until the explicit conflicts are resolved. */
  conflicts: number;
  reviewRequired: true;
  paths: AuthoredRefreshPath[];
}

async function writeProposalFile(
  destination: string,
  path: string,
  bytes: Buffer | string,
  mode: string = '100644'
): Promise<void> {
  assertSourcePath(path);
  await mkdir(dirname(join(destination, path)), { recursive: true });
  await writeFile(join(destination, path), bytes);
  await chmod(join(destination, path), mode === '100755' ? 0o755 : 0o644);
}

async function validateProposalDestination(
  snapshot: AuthoredSnapshot,
  donor: string,
  destination: string
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  // The output must be external even when its parent is a symlink into an editing tree.
  const canonical = join(await realpath(dirname(destination)), destination.split(sep).at(-1) ?? '');
  for (const source of [snapshot.repository, donor]) {
    const root = await realpath(source);
    if (canonical === root || canonical.startsWith(root + sep) || root.startsWith(canonical + sep))
      throw new GeneralError('authored-refresh-destination: use a separate disposable directory');
  }
}

async function persistMergedImage(
  destination: string,
  sourceRoot: string,
  generated: GeneratedSource | undefined,
  path: string,
  image: RefreshImage
): Promise<void> {
  if (!generated) {
    await writeProposalFile(destination, `${sourceRoot}/${path}`, image.bytes, image.mode);
    return;
  }
  if (image.mode !== '100644') throw new GeneralError('generated-mode-requires-source-contract');
  let bytes = image.bytes;
  if (path.endsWith('.css')) {
    const expanded = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const candidate = stripExpandedFragments(expanded);
    const composed = await composeComponentSource(
      candidate,
      path,
      join(destination, 'components/shared')
    );
    if (!Buffer.from(composed).equals(bytes))
      throw new GeneralError('generated-fragment-reverse-not-lossless');
    bytes = Buffer.from(candidate);
  }
  await writeProposalFile(destination, generated.sourcePath, bytes, image.mode);
}

interface RefreshContext {
  snapshot: AuthoredSnapshot;
  destination: string;
  pin: AuthoredSnapshot['pin'];
  pristine: ReadonlyMap<string, CapturedInput>;
  /** Touched paths whose new pristine form is not one regular file: the reason it cannot merge. */
  blocked: ReadonlyMap<string, string>;
  oldBlobs: ReadonlyMap<string, Buffer>;
  newBlobs: ReadonlyMap<string, Buffer>;
  localBlobs: ReadonlyMap<string, Buffer>;
  generated: ReadonlyMap<string, GeneratedSource>;
}

function canRetireOverride(
  source: GeneratedSource | undefined,
  upstream: CapturedInput | undefined,
  image: RefreshImage | undefined,
  bytes: Buffer | undefined
): boolean {
  if (source) return false;
  if (!upstream) return true;
  return (
    image !== undefined &&
    image.mode === upstream.mode &&
    image.bytes.equals(bytes ?? Buffer.alloc(0))
  );
}

/** Write what a reviewer needs for a conflict under `conflicts/`, outside every source root. */
async function writeConflictFiles(
  destination: string,
  path: string,
  merge: {
    markers?: Buffer;
    sides: Record<'base' | 'local' | 'upstream', RefreshImage | undefined>;
  }
): Promise<string[]> {
  const files: [string, Buffer][] = merge.markers
    ? [[`conflicts/${path}`, merge.markers]]
    : Object.entries(merge.sides).flatMap(([side, image]) =>
        image ? [[`conflicts/${path}.${side}`, image.bytes] as [string, Buffer]] : []
      );
  for (const [file, bytes] of files) await writeProposalFile(destination, file, bytes);
  return files.map(([file]) => file);
}

async function refreshPath(
  context: RefreshContext,
  file: AuthoredFile
): Promise<AuthoredRefreshPath> {
  const {
    snapshot,
    destination,
    pin,
    pristine,
    oldBlobs,
    newBlobs,
    localBlobs,
    generated,
    blocked,
  } = context;
  const sources = requireAuthoredConfig(snapshot.config);
  const upstreamEntry = pristine.get(file.path);
  const reason = blocked.get(file.path);
  if (reason) return { path: file.path, outcome: 'conflict', reason };
  if (!file.declaration)
    return upstreamEntry
      ? { path: file.path, outcome: 'conflict', reason: 'created-now-shadows-upstream' }
      : { path: file.path, outcome: 'created' };
  const declaration = file.declaration;
  const baseBytes = oldBlobs.get(declaration.base.blob);
  const localBytes = file.blob ? localBlobs.get(file.blob) : undefined;
  const upstreamBytes = upstreamEntry ? newBlobs.get(upstreamEntry.blob) : undefined;
  if (!baseBytes || (file.blob && !localBytes) || (upstreamEntry && !upstreamBytes))
    throw new GeneralError(`authored-object-unavailable: ${file.path}`);
  const sides = {
    base: { bytes: baseBytes, mode: declaration.base.mode },
    local: localBytes ? { bytes: localBytes, mode: file.mode } : undefined,
    upstream:
      upstreamBytes && upstreamEntry
        ? { bytes: upstreamBytes, mode: upstreamEntry.mode }
        : undefined,
  };
  const result = await mergeRefreshImages(sides.base, sides.local, sides.upstream);
  if (!result.ok)
    return {
      path: file.path,
      outcome: 'conflict',
      reason: result.reason,
      conflictFiles: await writeConflictFiles(destination, file.path, {
        ...(result.markers ? { markers: result.markers } : {}),
        sides,
      }),
    };
  const source = generated.get(file.path);
  if (!result.image && source)
    return {
      path: file.path,
      outcome: 'conflict',
      reason: 'generated-removal-requires-source-contract',
    };
  const sidecar = `${sources.metadataRoot}/overrides/${file.path}.json`;
  const retire = canRetireOverride(source, upstreamEntry, result.image, upstreamBytes);
  if (!upstreamEntry && result.image)
    return {
      path: file.path,
      outcome: 'conflict',
      reason: 'upstream-removal-requires-created-classification',
    };
  try {
    if (!retire && result.image)
      await persistMergedImage(destination, sources.root, source, file.path, result.image);
    else if (!source) await rm(join(destination, sources.root, file.path), { force: true });
    if (retire) await rm(join(destination, sidecar), { force: true });
    else if (upstreamEntry) {
      const next: UpstreamDeclaration = {
        ...declaration,
        base: {
          pin: pin.digest,
          commit: pin.commit,
          blob: upstreamEntry.blob,
          mode: upstreamEntry.mode,
        },
      };
      await writeProposalFile(destination, sidecar, canonicalJson(next) + '\n');
    }
  } catch (error: unknown) {
    return {
      path: file.path,
      outcome: 'conflict',
      reason: toError(error).message,
    };
  }
  return {
    path: file.path,
    outcome: retire ? 'retired' : 'clean',
    ...(result.image
      ? {
          output: {
            sha256: createHash('sha256').update(result.image.bytes).digest('hex'),
            mode: result.image.mode,
          },
        }
      : {}),
  };
}

/** New pristine regular files for touched paths, and the paths a directory/file change blocks. */
async function readRefreshTargets(
  repository: string,
  commit: string,
  paths: readonly string[]
): Promise<{ pristine: Map<string, CapturedInput>; blocked: Map<string, string> }> {
  const ancestors = (path: string): string[] =>
    path
      .split('/')
      .slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  const records = await readPristineRecords(repository, commit, [
    ...new Set(paths.flatMap((path) => [path, ...ancestors(path)])),
  ]);
  const pristine = new Map<string, CapturedInput>();
  const blocked = new Map<string, string>();
  for (const path of paths) {
    const record = records.get(path);
    const fileAbove = ancestors(path).find((ancestor) => records.get(ancestor)?.type === 'blob');
    if (fileAbove) blocked.set(path, `upstream-file-at-ancestor: ${fileAbove}`);
    else if (record?.type === 'tree') blocked.set(path, 'upstream-directory-at-path');
    else if (record && (record.mode === '100644' || record.mode === '100755'))
      pristine.set(path, { path, blob: record.oid, mode: record.mode });
    else if (record) blocked.set(path, `upstream-kind-change: mode ${record.mode}`);
  }
  return { pristine, blocked };
}

/** Prepare a reviewable three-way refresh outside every project/donor; never change a live pin or source file. */
export async function refreshAuthoredSnapshot(
  options: RefreshAuthoredOptions
): Promise<AuthoredRefreshProposal> {
  const oldRepository = pristineRepositoryFor(
    options.snapshot.repository,
    options.oldPristineRepository
  );
  const snapshot = await authenticateAuthoredSnapshot(options.snapshot, oldRepository);
  const destination = resolve(options.destination);
  const newRepository = resolve(options.newPristineRepository);
  await validateProposalDestination(snapshot, oldRepository, destination);
  await validateProposalDestination(snapshot, newRepository, destination);
  const sources = requireAuthoredConfig(snapshot.config);
  const nextConfig = validateConfig({
    ...snapshot.config,
    firefox: options.newPin.firefox,
    sources: { ...sources, pristineCommit: options.newPin.commit },
  });
  const commit = (
    await sourceGit(newRepository, ['rev-parse', '--verify', `${options.newPin.commit}^{commit}`])
  )
    .toString('utf8')
    .trim();
  if (commit !== options.newPin.commit)
    throw new GeneralError('authored-refresh-new-pin-not-exact');
  const pin = {
    firefox: nextConfig.firefox,
    commit,
    digest: digest({ firefox: nextConfig.firefox, commit }),
  };
  if (pin.digest === snapshot.pin.digest) throw new GeneralError('authored-refresh-pin-unchanged');
  const { pristine, blocked } = await readRefreshTargets(
    newRepository,
    commit,
    snapshot.files.map((file) => file.path)
  );
  const [oldBlobs, newBlobs, localBlobs] = await Promise.all([
    readSourceBlobs(
      oldRepository,
      snapshot.files.flatMap((file) => (file.declaration ? [file.declaration.base.blob] : []))
    ),
    readSourceBlobs(
      newRepository,
      [...pristine.values()].map((entry) => entry.blob)
    ),
    readSourceBlobs(
      snapshot.repository,
      snapshot.files.flatMap((file) => (file.blob ? [file.blob] : []))
    ),
  ]);
  const generated = await composeCapturedFurnace(
    snapshot.repository,
    snapshot.inputs,
    snapshot.objectFormat
  );
  await exportCapturedTree(snapshot, destination);
  const context: RefreshContext = {
    snapshot,
    destination,
    pin,
    pristine,
    oldBlobs,
    newBlobs,
    localBlobs,
    generated,
    blocked,
  };
  const paths: AuthoredRefreshPath[] = [];
  for (const file of snapshot.files) paths.push(await refreshPath(context, file));
  await writeProposalFile(
    destination,
    'fireforge.json',
    JSON.stringify(nextConfig, null, 2) + '\n'
  );
  const proposal: AuthoredRefreshProposal = {
    schemaVersion: 1,
    sourceId: snapshot.id,
    oldPin: snapshot.pin,
    newPin: pin,
    destination,
    conflicts: paths.filter((path) => path.outcome === 'conflict').length,
    reviewRequired: true,
    paths,
  };
  await writeProposalFile(
    destination,
    'authored-refresh-proposal.json',
    JSON.stringify(proposal, null, 2) + '\n'
  );
  return proposal;
}
