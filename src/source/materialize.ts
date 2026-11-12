// SPDX-License-Identifier: EUPL-1.2
/**
 * Materialization: bringing an engine checkout of the pristine commit to
 * exactly pristine plus the checkout's owned files, writing only what
 * differs. It runs before every build and test, so an unchanged run reads
 * no file content: the ledger remembers each owned file's signature (size,
 * mtime, ctime and inode) and what was written for it. A signature vouches
 * for content only for a file last modified well before the run that
 * recorded it started, so an edit within the same timestamp tick is never
 * mistaken for no edit; the ctime and inode catch a file replaced or
 * rewritten with its mtime preserved.
 *
 * Ownership rule. Materialization owns exactly two sets of engine paths:
 * the paths its ledger records (what it wrote last time) and the paths the
 * checkout owns now. Every other engine path, including the build's output
 * and files other steps deploy after it (Furnace components), is never
 * read or written. Within its paths it changes an engine file only when the
 * file holds an image it can account for: what the ledger says it wrote,
 * what a later step deployed on top of that ({@link recordDeployment}), or,
 * for a path the ledger does not record, the pristine bytes (or absence,
 * for a path upstream lacks). Anything else is drift someone else made; it
 * is reported and nothing is changed.
 *
 * The engine writes and the ledger update run as one journal transaction,
 * so an error, a signal or a crash leaves the old state or the new one. An
 * interrupted run is undone before the next one looks at the engine.
 */
import { join } from 'node:path';

import { listTree, objectFormat, resolveRevision } from '../git/index.js';
import { defined, ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, pathInfo, readBytes, walkFiles, writeFile } from '../kernel/fs.js';
import { recoverJournal, transaction } from '../kernel/journal.js';
import { readJsonIfExists, stringifyJson } from '../kernel/json.js';
import { type Infer, s } from '../kernel/schema.js';
import type { SourceProject } from '../project/index.js';
import { blobId, type ObjectFormat, readPristineBlobs } from './objects.js';
import { compareText, type Pristine, type RegularMode } from './records.js';
import { readSourceTree, type SourceEntry, type SourceTree } from './tree.js';

const signatureSchema = s.object({
  size: s.int({ min: 0 }),
  mtimeMs: s.number(),
  ctimeMs: s.number(),
  ino: s.number(),
});

const ledgerSchema = s.object({
  pristineCommit: s.string(),
  /** When the run that wrote the ledger started reading files, in epoch milliseconds. */
  readAt: s.number(),
  files: s.record(
    s.object({
      /** What materialization left at the path; null for a deletion. */
      blob: s.union(s.string(), s.literal(null)),
      mode: s.enum(['100644', '100755']),
      /** The engine file's signature as last seen. */
      engine: signatureSchema.optional(),
      /** The owned file's signature when `blob` was read from it. */
      source: signatureSchema.optional(),
      /** The blob a later step (a component deployment) left at the path over `blob`. */
      deployed: s.string().optional(),
    })
  ),
});

type Ledger = Infer<typeof ledgerSchema>;
type LedgerEntry = Ledger['files'][string];
type Signature = Infer<typeof signatureSchema>;

/** A file's content identity: blob and mode, or null for absent. */
type Image = { readonly blob: string; readonly mode: RegularMode } | null;

/** What {@link materialize} changed in the engine. */
export interface MaterializeResult {
  /** Owned files written. */
  readonly written: readonly string[];
  /** Upstream files given back their pristine bytes. */
  readonly restored: readonly string[];
  /** Files deleted: new tombstones, and created files no longer owned. */
  readonly removed: readonly string[];
}

/** Where an engine and its materialization state live. */
export interface MaterializeTarget {
  /** A git checkout of the pristine commit, possibly holding an earlier materialization. */
  readonly engineDir: string;
  /** Where the ledger and journal of this engine live, outside it. */
  readonly stateDir: string;
}

const LEDGER = 'source-ledger.json';
const JOURNAL = 'source-materialize.journal';

/**
 * How much older than the reading run a file's timestamps must be before its
 * signature vouches for its content: the coarsest timestamp granularity in use
 * (FAT keeps two seconds).
 */
const RACY_MS = 2_000;

/** The facts about a file that stand in for reading it. */
function signatureOf(file: Signature): Signature {
  return { size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs, ino: file.ino };
}

function sameImage(a: Image, b: Image): boolean {
  return a === null || b === null ? a === b : a.blob === b.blob && a.mode === b.mode;
}

/** Whether a recorded signature still vouches for the content it was recorded with. */
function vouches(recorded: Signature | undefined, now: Signature, readAt: number): boolean {
  return (
    recorded !== undefined &&
    recorded.size === now.size &&
    recorded.mtimeMs === now.mtimeMs &&
    recorded.ctimeMs === now.ctimeMs &&
    recorded.ino === now.ino &&
    Math.max(now.mtimeMs, now.ctimeMs) < readAt - RACY_MS
  );
}

const ledgerImage = (entry: LedgerEntry): Image =>
  entry.blob === null ? null : { blob: entry.blob, mode: entry.mode };

const deployedImage = (entry: LedgerEntry): NonNullable<Image> | undefined =>
  entry.deployed === undefined ? undefined : { blob: entry.deployed, mode: entry.mode };

/** One path's plan: what it must hold, what it holds, and the bytes to write. */
interface Step {
  readonly path: string;
  readonly target: Image;
  /** Present when the owned file supplies the target. */
  readonly entry?: SourceEntry;
  readonly action: 'write' | 'restore' | 'remove' | 'keep';
  readonly drift: boolean;
}

class Planner {
  /** Owned bytes read while hashing, reused for the write. */
  readonly bytes = new Map<string, Buffer>();
  readonly ledger: Ledger;

  constructor(
    readonly engine: string,
    private readonly format: ObjectFormat,
    readonly previous: Ledger,
    next: { commit: string; readAt: number }
  ) {
    this.ledger = { pristineCommit: next.commit, readAt: next.readAt, files: {} };
  }

  /** The image an owned entry supplies, reading the file only when the ledger can vouch for none. */
  async desired(entry: SourceEntry): Promise<Image> {
    if (entry.file === undefined) return null;
    const known = this.previous.files[entry.path];
    const signature = signatureOf(entry.file);
    if (
      known !== undefined &&
      known.blob !== null &&
      vouches(known.source, signature, this.previous.readAt)
    ) {
      return { blob: known.blob, mode: entry.file.mode };
    }
    const bytes = await readBytes(entry.file.absolute);
    this.bytes.set(entry.path, bytes);
    return { blob: blobId(bytes, this.format), mode: entry.file.mode };
  }

  /** The engine's image at a path, or what is there instead of a file. */
  async actual(
    path: string
  ): Promise<{ image: Image; signature?: Signature } | 'directory' | 'other'> {
    const info = await pathInfo(join(this.engine, path));
    if (info === undefined) return { image: null };
    if (info.kind === 'directory') return 'directory';
    if (info.kind !== 'file') return 'other';
    const signature = signatureOf(info);
    const mode = (info.mode & 0o111) !== 0 ? '100755' : '100644';
    const known = this.previous.files[path];
    if (
      known !== undefined &&
      known.blob !== null &&
      known.mode === mode &&
      vouches(known.engine, signature, this.previous.readAt)
    ) {
      return { image: { blob: known.deployed ?? known.blob, mode }, signature };
    }
    const bytes = await readBytes(join(this.engine, path));
    return { image: { blob: blobId(bytes, this.format), mode }, signature };
  }

  record(
    path: string,
    target: Image,
    entry: SourceEntry | undefined,
    engine: { signature?: Signature; deployed?: string } = {}
  ): void {
    const file = entry?.file;
    const recorded: LedgerEntry = {
      blob: target?.blob ?? null,
      mode: target?.mode ?? '100644',
      ...(engine.signature === undefined ? {} : { engine: engine.signature }),
      ...(file === undefined ? {} : { source: signatureOf(file) }),
      ...(engine.deployed === undefined ? {} : { deployed: engine.deployed }),
    };
    this.ledger.files[path] = recorded;
  }
}

/** Pristine images of paths, from the pristine repository. */
async function pristineImages(
  pristine: Pristine,
  paths: readonly string[]
): Promise<Map<string, Image>> {
  const images = new Map<string, Image>(paths.map((path) => [path, null]));
  if (paths.length === 0) return images;
  for (const entry of await listTree(pristine.repo, pristine.commit, {
    paths,
    recursive: false,
  })) {
    if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')) {
      images.set(entry.path, { blob: entry.oid, mode: entry.mode });
    }
  }
  return images;
}

function refuseBlocked(tree: SourceTree): void {
  const blocking = tree.problems.filter((problem) => problem.blocking);
  if (blocking.length === 0) return;
  throw new FireForgeError(
    'source-invalid',
    `The owned files cannot be materialized:\n${blocking
      .map((problem) => `  ${problem.path}: ${problem.message}`)
      .join('\n')}`,
    { exitCode: ExitCode.CONFIG_ERROR, hint: 'Run "fireforge verify" and fix what it reports.' }
  );
}

async function readLedger(stateDir: string, pristine: Pristine): Promise<Ledger | undefined> {
  const ledger = await readJsonIfExists(join(stateDir, LEDGER), ledgerSchema, {
    code: 'state-invalid',
    exitCode: ExitCode.CONFIG_ERROR,
    hint: 'Run "fireforge workspace repair" to rebuild the workspace.',
  });
  if (ledger !== undefined && ledger.pristineCommit !== pristine.commit) {
    throw new FireForgeError(
      'materialize-pin-mismatch',
      `The workspace was materialized for pristine commit ${ledger.pristineCommit}, not ${pristine.commit}.`,
      { exitCode: ExitCode.CONFIG_ERROR, hint: 'Run "fireforge workspace repair".' }
    );
  }
  return ledger;
}

/** Plans one path. */
async function planPath(
  planner: Planner,
  path: string,
  owned: { entry: SourceEntry; image: Image } | undefined,
  pristine: Image,
  removing: ReadonlySet<string>
): Promise<Step> {
  const target = owned === undefined ? pristine : owned.image;
  const known = planner.previous.files[path];
  const deployed = known === undefined ? undefined : deployedImage(known);
  const accounted: Image[] =
    known === undefined
      ? [pristine]
      : [ledgerImage(known), ...(deployed === undefined ? [] : [deployed])];
  const actual = await planner.actual(path);
  const entry = owned?.entry;
  const action: Step['action'] =
    owned !== undefined
      ? target === null
        ? 'remove'
        : 'write'
      : target === null
        ? 'remove'
        : 'restore';
  if (actual === 'other') return { path, target, action, drift: true, ...(entry && { entry }) };
  if (actual === 'directory') {
    // A directory gives way to a file only when everything in it leaves in this run.
    const inside = await walkFiles(join(planner.engine, path));
    const clears = target !== null && inside.every((file) => removing.has(`${path}/${file}`));
    return { path, target, action, drift: !clears, ...(entry && { entry }) };
  }
  const signature = actual.signature === undefined ? {} : { signature: actual.signature };
  if (sameImage(actual.image, target)) {
    if (owned !== undefined) planner.record(path, target, entry, signature);
    return { path, target, action: 'keep', drift: false, ...(entry && { entry }) };
  }
  // The owned bytes are unchanged and the engine holds what a deployment made of them.
  if (
    owned !== undefined &&
    known !== undefined &&
    deployed !== undefined &&
    sameImage(target, ledgerImage(known)) &&
    sameImage(actual.image, deployed)
  ) {
    planner.record(path, target, entry, { ...signature, deployed: deployed.blob });
    return { path, target, action: 'keep', drift: false, ...(entry && { entry }) };
  }
  return {
    path,
    target,
    action,
    drift: !accounted.some((image) => sameImage(actual.image, image)),
    ...(entry && { entry }),
  };
}

/** Removes the directories a removal left empty, deepest first, up to the engine root. */
async function emptiedDirectories(
  engineDir: string,
  removed: readonly string[]
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const path of removed) {
    const parts = path.split('/');
    for (let depth = parts.length - 1; depth > 0; depth--)
      candidates.add(parts.slice(0, depth).join('/'));
  }
  const empty = new Set<string>();
  const ordered = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const directory of ordered) {
    const entries = await listDir(join(engineDir, directory));
    if (entries.every((entry) => empty.has(`${directory}/${entry.name}`))) empty.add(directory);
  }
  return ordered.filter((directory) => empty.has(directory));
}

/**
 * Brings an engine checkout of the pristine commit to exactly pristine plus
 * the checkout's owned files: writes owned files that differ, restores the
 * pristine bytes of upstream paths no longer owned, deletes tombstoned paths
 * and created files no longer owned, and keeps executable modes. A run an
 * earlier process left unfinished is undone first. See the module comment
 * for which engine paths it may change.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @param target - The engine and where its ledger and journal live
 * @throws `source-invalid` when an owned path is undefined, `materialize-drift`
 *   when an engine file changed outside FireForge, `materialize-pin-mismatch`,
 *   `materialize-wrong-engine`, and the journal recovery errors
 */
export async function materialize(
  project: SourceProject,
  pristine: Pristine,
  target: MaterializeTarget
): Promise<MaterializeResult> {
  const { engineDir, stateDir } = target;
  await recoverJournal(join(stateDir, JOURNAL));
  const readAt = Date.now();
  const tree = await readSourceTree(project, pristine);
  refuseBlocked(tree);
  if ((await resolveRevision(engineDir, 'HEAD', 'commit')) !== pristine.commit) {
    throw new FireForgeError(
      'materialize-wrong-engine',
      `${engineDir} is not a checkout of pristine commit ${pristine.commit}.`,
      { exitCode: ExitCode.GIT_ERROR, hint: 'Run "fireforge workspace repair".' }
    );
  }
  const previous = (await readLedger(stateDir, pristine)) ?? {
    pristineCommit: pristine.commit,
    readAt: 0,
    files: {},
  };
  const planner = new Planner(engineDir, await objectFormat(pristine.repo), previous, {
    commit: pristine.commit,
    readAt,
  });
  const owned = new Map<string, { entry: SourceEntry; image: Image }>();
  for (const entry of tree.entries)
    owned.set(entry.path, { entry, image: await planner.desired(entry) });
  const leaving = Object.keys(previous.files).filter((path) => !owned.has(path));
  // Owned entries carry their pristine image; a created file has none upstream.
  const upstream = await pristineImages(pristine, leaving);
  for (const entry of tree.entries) upstream.set(entry.path, entry.upstream ?? null);
  const paths = [...new Set([...owned.keys(), ...leaving])].sort(compareText);
  const targetOf = (path: string): Image => {
    const supplied = owned.get(path);
    return supplied === undefined ? (upstream.get(path) ?? null) : supplied.image;
  };
  const removing = new Set(paths.filter((path) => targetOf(path) === null));
  const steps: Step[] = [];
  for (const path of paths) {
    steps.push(
      await planPath(planner, path, owned.get(path), upstream.get(path) ?? null, removing)
    );
  }
  const drifted = steps.filter((step) => step.drift);
  if (drifted.length > 0) {
    throw new FireForgeError(
      'materialize-drift',
      `Engine files changed outside FireForge; materialization would overwrite them:\n${drifted
        .slice(0, 20)
        .map((step) => `  ${step.path}`)
        .join('\n')}${drifted.length > 20 ? `\n  and ${drifted.length - 20} more` : ''}`,
      { hint: 'Save anything you need from them, then run "fireforge workspace repair".' }
    );
  }
  return apply(planner, steps, { pristine, engineDir, stateDir });
}

async function apply(
  planner: Planner,
  steps: readonly Step[],
  context: { pristine: Pristine; engineDir: string; stateDir: string }
): Promise<MaterializeResult> {
  const { pristine, engineDir, stateDir } = context;
  const changing = steps.filter((step) => step.action !== 'keep');
  const ledgerPath = join(stateDir, LEDGER);
  if (changing.length === 0) {
    await writeFile(ledgerPath, stringifyJson(planner.ledger, { sortKeys: true }));
    return { written: [], restored: [], removed: [] };
  }
  const restoredBlobs = changing.flatMap((step) =>
    step.action === 'restore' && step.target !== null ? [step.target.blob] : []
  );
  const pristineBytes = await readPristineBlobs(pristine, restoredBlobs);
  const removals = changing
    .filter((step) => step.target === null)
    .sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length || compareText(a.path, b.path)
    );
  const writes = changing.filter((step) => step.target !== null);
  await transaction(join(stateDir, JOURNAL), 'the materialization', async (tx) => {
    for (const step of removals) await tx.remove(join(engineDir, step.path));
    for (const directory of await emptiedDirectories(
      engineDir,
      removals.map((step) => step.path)
    )) {
      await tx.remove(join(engineDir, directory));
    }
    for (const step of writes) {
      const target = join(engineDir, step.path);
      if ((await pathInfo(target))?.kind === 'directory') await tx.remove(target);
      const bytes =
        step.entry === undefined
          ? pristineBytes.get(step.target?.blob ?? '')
          : (planner.bytes.get(step.path) ?? (await readBytes(step.entry.file?.absolute ?? '')));
      await tx.write(
        target,
        defined(bytes, () => `the content of ${step.path} was read`),
        {
          mode: step.target?.mode === '100755' ? 0o755 : 0o644,
        }
      );
    }
    for (const step of changing) {
      if (step.entry === undefined) continue;
      const info = step.target === null ? undefined : await pathInfo(join(engineDir, step.path));
      planner.record(
        step.path,
        step.target,
        step.entry,
        info === undefined ? {} : { signature: signatureOf(info) }
      );
    }
    await tx.write(ledgerPath, stringifyJson(planner.ledger, { sortKeys: true }));
  });
  const pathsOf = (action: Step['action']): string[] =>
    changing.filter((step) => step.action === action).map((step) => step.path);
  return { written: pathsOf('write'), restored: pathsOf('restore'), removed: pathsOf('remove') };
}

/**
 * Accepts what a step after materialization (a component deployment) wrote
 * at owned paths of an engine, so the next materialization counts those
 * bytes as accounted for rather than as drift. Paths the ledger does not
 * record are not materialization's and are left out.
 *
 * @param pristine - The pinned pristine repository
 * @param target - The engine and where its ledger lives
 * @param paths - Engine paths the step wrote or removed
 */
export async function recordDeployment(
  pristine: Pristine,
  target: MaterializeTarget,
  paths: readonly string[]
): Promise<void> {
  const ledger = await readLedger(target.stateDir, pristine);
  if (ledger === undefined) return;
  const format = await objectFormat(pristine.repo);
  let changed = false;
  for (const path of paths) {
    const entry = ledger.files[path];
    const absolute = join(target.engineDir, path);
    const info = await pathInfo(absolute);
    if (entry === undefined || entry.blob === null || info?.kind !== 'file') continue;
    const blob = blobId(await readBytes(absolute), format);
    const next: LedgerEntry = { ...entry, engine: signatureOf(info) };
    if (blob === entry.blob) delete next.deployed;
    else next.deployed = blob;
    ledger.files[path] = next;
    changed = true;
  }
  if (changed) {
    await writeFile(join(target.stateDir, LEDGER), stringifyJson(ledger, { sortKeys: true }));
  }
}
