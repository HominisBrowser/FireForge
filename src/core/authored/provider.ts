// SPDX-License-Identifier: EUPL-1.2
import { GeneralError } from '../../errors/base.js';
import { isObject } from '../../utils/validation.js';
import { validateConfig } from '../config-validate.js';
import {
  authenticateGeneratedTree,
  composeCapturedFurnace,
  type GeneratedSource,
  storeGeneratedTree,
} from './generated.js';
import {
  assertSourceObjectsAvailable,
  canonicalJson,
  digest,
  isObjectId,
  listSourceTree,
  parseSourceTreeRecords,
  pristineRepositoryFor,
  readSourceBlob,
  readSourceBlobs,
  sourceGit,
  type SourceTreeRecord,
} from './git.js';
import {
  assertPristinePath,
  assertSourceMode,
  assertSourcePath,
  validateAuthoredConfig,
} from './paths.js';
import type {
  AuthoredFile,
  AuthoredSnapshot,
  AuthoredSourceConfig,
  CapturedInput,
  UpstreamDeclaration,
} from './types.js';

/** Require and validate the explicit authored-source configuration. */
export function requireAuthoredConfig(config: {
  sources?: AuthoredSourceConfig;
}): AuthoredSourceConfig {
  if (!config.sources)
    throw new GeneralError(
      'authored-mode-required: configure sources before using authored source'
    );
  validateAuthoredConfig(config.sources);
  return config.sources;
}

/** Validate one sidecar document's shape; its claims are authenticated against pristine later. */
export function parseDeclaration(value: unknown): UpstreamDeclaration {
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    (value['kind'] !== 'override' && value['kind'] !== 'delete') ||
    typeof value['path'] !== 'string' ||
    typeof value['component'] !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value['component']) ||
    (value['classification'] !== 'registration' && value['classification'] !== 'exception') ||
    !isObject(value['base'])
  ) {
    throw new GeneralError('authored-invalid-declaration: invalid upstream sidecar');
  }
  const base = value['base'];
  if (
    typeof base['pin'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(base['pin']) ||
    !isObjectId(base['commit']) ||
    !isObjectId(base['blob']) ||
    typeof base['mode'] !== 'string'
  )
    throw new GeneralError('authored-invalid-declaration: invalid base identity');
  assertSourceMode(base['mode']);
  assertSourcePath(value['path']);
  const adr = value['adr'];
  if (adr !== undefined && typeof adr !== 'string')
    throw new GeneralError('authored-invalid-declaration: adr must be a path');
  if (typeof adr === 'string') assertSourcePath(adr);
  if (value['classification'] === 'exception' && !adr)
    throw new GeneralError('authored-adr-required: upstream exception requires an ADR');
  return {
    schemaVersion: 1,
    kind: value['kind'],
    path: value['path'],
    component: value['component'],
    classification: value['classification'],
    base: { pin: base['pin'], commit: base['commit'], blob: base['blob'], mode: base['mode'] },
    ...(typeof adr === 'string' ? { adr } : {}),
  };
}

function assertPristineCommit(commit: string): void {
  if (!isObjectId(commit)) throw new GeneralError('authored-invalid-pristine-commit');
}

/** Read exactly one pristine object; declarations never authenticate each other. */
export async function readPristineEntry(
  repository: string,
  commit: string,
  path: string
): Promise<CapturedInput | undefined> {
  return (await readPristineEntries(repository, commit, [path])).get(path);
}

const PRISTINE_BATCH = 1024;

/** Raw pristine entries for paths, whatever their kind; absent paths have no entry. */
export async function readPristineRecords(
  repository: string,
  commit: string,
  paths: readonly string[]
): Promise<Map<string, SourceTreeRecord>> {
  assertPristineCommit(commit);
  paths.forEach((path) => {
    assertPristinePath(path);
  });
  const records = new Map<string, SourceTreeRecord>();
  for (let start = 0; start < paths.length; start += PRISTINE_BATCH) {
    const raw = await sourceGit(repository, [
      'ls-tree',
      '-z',
      commit,
      '--',
      ...paths.slice(start, start + PRISTINE_BATCH),
    ]);
    for (const record of parseSourceTreeRecords(raw)) records.set(record.path, record);
  }
  return records;
}

/** Resolve a path batch without one subprocess per authored file; only regular files qualify. */
export async function readPristineEntries(
  repository: string,
  commit: string,
  paths: readonly string[]
): Promise<Map<string, CapturedInput>> {
  const entries = new Map<string, CapturedInput>();
  for (const [path, { mode, type, oid }] of await readPristineRecords(repository, commit, paths)) {
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755'))
      throw new GeneralError(`override-base-kind: ${path} is not a pristine regular file`);
    entries.set(path, { path, blob: oid, mode });
  }
  return entries;
}

interface OverlayInventory {
  declarations: Map<string, UpstreamDeclaration>;
  sourceFiles: Map<string, CapturedInput>;
}

async function readOverlayInventory(
  repository: string,
  inputs: readonly CapturedInput[],
  sources: AuthoredSourceConfig,
  generated: ReadonlyMap<string, GeneratedSource>
): Promise<OverlayInventory> {
  const declarations = new Map<string, UpstreamDeclaration>();
  const sourceFiles = new Map<string, CapturedInput>();
  const folded = new Map<string, string>();
  const sidecars = await readSourceBlobs(
    repository,
    inputs
      .filter((entry) => entry.path.startsWith(`${sources.metadataRoot}/overrides/`))
      .map((entry) => entry.blob)
  );
  for (const entry of inputs) {
    assertSourcePath(entry.path);
    const lower = entry.path.normalize('NFC').toLocaleLowerCase('en-US');
    const previous = folded.get(lower);
    if (previous && previous !== entry.path)
      throw new GeneralError(`authored-case-collision: ${previous}, ${entry.path}`);
    folded.set(lower, entry.path);
    if (entry.path.startsWith(`${sources.root}/`)) {
      const path = entry.path.slice(sources.root.length + 1);
      if (path === '.gitignore' || path === '.gitattributes') continue;
      if (path === 'mozconfig')
        throw new GeneralError(
          'authored-in-build-output: mozconfig is generated from captured configs'
        );
      assertSourcePath(path);
      if (generated.has(path)) throw new GeneralError(`authored-in-furnace-target: ${path}`);
      sourceFiles.set(path, entry);
    }
    if (entry.path.startsWith(`${sources.metadataRoot}/overrides/`)) {
      const path = entry.path.slice(`${sources.metadataRoot}/overrides/`.length);
      if (!path.endsWith('.json'))
        throw new GeneralError(`authored-invalid-declaration: ${entry.path}`);
      const bytes = sidecars.get(entry.blob);
      if (!bytes) throw new GeneralError(`authored-object-unavailable: ${entry.path}`);
      const declaration = parseDeclaration(JSON.parse(bytes.toString('utf8')) as unknown);
      if (path !== `${declaration.path}.json` || declarations.has(declaration.path))
        throw new GeneralError(`authored-invalid-declaration: mismatched sidecar ${entry.path}`);
      declarations.set(declaration.path, declaration);
    }
  }
  return { declarations, sourceFiles };
}

async function classifyInventory(
  inputs: readonly CapturedInput[],
  pin: AuthoredSnapshot['pin'],
  pristineRepository: string,
  inventory: OverlayInventory,
  generated: ReadonlyMap<string, GeneratedSource>
): Promise<AuthoredFile[]> {
  const { declarations, sourceFiles } = inventory;
  const files: AuthoredFile[] = [];
  const paths = [
    ...new Set([...sourceFiles.keys(), ...declarations.keys(), ...generated.keys()]),
  ].sort();
  const pristineByPath = await readPristineEntries(pristineRepository, pin.commit, paths);
  const inputPaths = new Set(inputs.map((entry) => entry.path));
  for (const path of paths) {
    const derived = generated.get(path);
    const source = sourceFiles.get(path) ?? derived;
    const declaration = declarations.get(path);
    const pristine = pristineByPath.get(path);
    if (declaration) {
      if (declaration.base.pin !== pin.digest || declaration.base.commit !== pin.commit)
        throw new GeneralError(`override-base-stale: ${path}`);
      if (
        !pristine ||
        pristine.blob !== declaration.base.blob ||
        pristine.mode !== declaration.base.mode
      )
        throw new GeneralError(`override-base-mismatch: ${path}`);
      if (declaration.kind === 'override' && !source)
        throw new GeneralError(`authored-orphan-declaration: ${path}`);
      if (declaration.kind === 'delete' && source)
        throw new GeneralError(`authored-delete-has-postimage: ${path}`);
      if (declaration.adr && !inputPaths.has(declaration.adr))
        throw new GeneralError(`authored-adr-missing: ${declaration.adr}`);
      files.push({
        path,
        kind: derived ? 'generated' : declaration.kind,
        mode: source?.mode ?? pristine.mode,
        ...(source ? { blob: source.blob } : {}),
        declaration,
      });
    } else {
      if (pristine)
        throw new GeneralError(
          `authored-shadows-upstream: ${path} exists upstream; declare it with "fireforge authored override ${path}"`
        );
      if (source)
        files.push({
          path,
          kind: derived ? 'generated' : 'created',
          blob: source.blob,
          mode: source.mode,
        });
    }
  }
  return files;
}

export interface SnapshotFromTreeOptions {
  pristineRepository?: string;
  /** The generated tree a handle claims: null when it claims none, undefined to store a new one. */
  expectedGeneratedTree?: string | null;
}

/** Snapshots this process built or authenticated, with the donor that vouched for them. */
const authenticated = new WeakMap<object, { donor: string; snapshot: AuthoredSnapshot }>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Reconstruct every decision from captured objects rather than live files. */
export async function snapshotFromTree(
  repository: string,
  tree: string,
  options: SnapshotFromTreeOptions = {}
): Promise<AuthoredSnapshot> {
  if (!isObjectId(tree))
    throw new GeneralError('authored-invalid-tree: full tree object id required');
  const pristineRepository = pristineRepositoryFor(repository, options.pristineRepository);
  const { expectedGeneratedTree } = options;
  const objectFormat = (await sourceGit(repository, ['rev-parse', '--show-object-format']))
    .toString('utf8')
    .trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    throw new GeneralError('authored-invalid-object-format');
  const inputs = await listSourceTree(repository, tree);
  await assertSourceObjectsAvailable(
    repository,
    inputs.map((entry) => entry.blob)
  );
  const configEntry = inputs.find((entry) => entry.path === 'fireforge.json');
  if (!configEntry)
    throw new GeneralError('authored-missing-config: captured tree has no fireforge.json');
  const config = validateConfig(
    JSON.parse((await readSourceBlob(repository, configEntry.blob)).toString('utf8')) as unknown
  );
  const sources = requireAuthoredConfig(config);
  const pin = {
    firefox: config.firefox,
    commit: sources.pristineCommit,
    digest: digest({ firefox: config.firefox, commit: sources.pristineCommit }),
  };
  const resolved = (
    await sourceGit(pristineRepository, ['rev-parse', '--verify', `${pin.commit}^{commit}`])
  )
    .toString('utf8')
    .trim();
  if (resolved !== pin.commit)
    throw new GeneralError('override-base-stale: pristine commit does not resolve exactly');
  const generated = await composeCapturedFurnace(repository, inputs, objectFormat);
  if (generated.size > 0 && expectedGeneratedTree === null)
    throw new GeneralError('authored-generated-tree-missing');
  const generatedTree =
    generated.size > 0
      ? (expectedGeneratedTree ?? (await storeGeneratedTree(repository, generated)))
      : undefined;
  if (generatedTree) await authenticateGeneratedTree(repository, generatedTree, generated);
  const inventory = await readOverlayInventory(repository, inputs, sources, generated);
  const files = await classifyInventory(inputs, pin, pristineRepository, inventory, generated);
  const snapshot: AuthoredSnapshot = {
    schemaVersion: 1,
    id: '',
    repository,
    tree,
    objectFormat: objectFormat,
    pin,
    config,
    inputs,
    files,
    ...(generatedTree ? { generatedTree } : {}),
  };
  snapshot.id = snapshotIdentity(snapshot);
  authenticated.set(deepFreeze(snapshot), { donor: pristineRepository, snapshot });
  return snapshot;
}

/** Portable identity: the same source and pin name the same snapshot on any host or checkout. */
function snapshotIdentity(
  snapshot: Pick<AuthoredSnapshot, 'tree' | 'objectFormat' | 'pin' | 'generatedTree'>
): string {
  return digest({
    schemaVersion: 1,
    tree: snapshot.tree,
    objectFormat: snapshot.objectFormat,
    pin: snapshot.pin,
    generatedTree: snapshot.generatedTree,
    generator: 'authored-v1',
  });
}

/**
 * The identity another tree has under this snapshot's pin and generated tree: what
 * a source differing from this one only outside the engine and its components was.
 */
export const snapshotIdentityOfTree = (snapshot: AuthoredSnapshot, tree: string): string =>
  snapshotIdentity({ ...snapshot, tree });

/** A serialized handle is checked against its actual immutable object closure. */
export async function authenticateAuthoredSnapshot(
  value: unknown,
  pristineRepository?: string
): Promise<AuthoredSnapshot> {
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    typeof value['repository'] !== 'string' ||
    typeof value['tree'] !== 'string' ||
    typeof value['id'] !== 'string' ||
    (value['generatedTree'] !== undefined && typeof value['generatedTree'] !== 'string')
  )
    throw new GeneralError('authored-snapshot-invalid');
  const donor = pristineRepositoryFor(value['repository'], pristineRepository);
  const known = authenticated.get(value);
  if (known?.donor === donor) return known.snapshot;
  const actual = await snapshotFromTree(value['repository'], value['tree'], {
    pristineRepository: donor,
    expectedGeneratedTree: value['generatedTree'] ?? null,
  });
  if (actual.id !== value['id'] || canonicalJson(actual) !== canonicalJson(value))
    throw new GeneralError(
      'authored-snapshot-mismatch: captured metadata does not match its Git tree'
    );
  return actual;
}
