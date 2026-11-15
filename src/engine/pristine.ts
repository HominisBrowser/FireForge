// SPDX-License-Identifier: EUPL-1.2
/**
 * The pristine repository of a pin: the Firefox source archive imported as
 * one commit, kept per host under `pristine/<pin key>/` and only read once it
 * exists. Every engine is a checkout of that commit, and every owned change
 * is measured against it.
 *
 * The commit is a function of the archive alone: fixed author, date and
 * message, and a tree holding exactly the archive's files. Every host that
 * imports the same archive therefore derives the same commit id, which is
 * what lets a project pin it.
 */
import { join } from 'node:path';

import {
  captureWorktree,
  cloneRepository,
  commitTree,
  fetchCommit,
  initRepository,
  isRepository,
  listTree,
  readBlobs,
  resolveRevision,
  saveRecoverySnapshot,
  setConfig,
  type TreeEntry,
  updateRef,
} from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import {
  appendText,
  copyFile,
  ensureDir,
  exists,
  listDir,
  move,
  remove,
  tempPathFor,
  walkFiles,
} from '../kernel/fs.js';
import { hashFile } from '../kernel/hash.js';
import { isRecord, readJsonIfExists, writeJson } from '../kernel/json.js';
import { withLock } from '../kernel/lock.js';
import { type Infer, s } from '../kernel/schema.js';
import type { HostPaths, PatchProject } from '../project/index.js';
import { type DownloadOptions, ensureArchive, extractArchive } from './archive.js';
import { type FirefoxPin, pinKey } from './pin.js';
import { OBJDIR_NAME, withEngineLock } from './workspace.js';

/** A pin's pristine repository and the commit holding the Firefox source. */
export interface Pristine {
  /** The bare repository, `pristine/<pin key>/` on the host. */
  readonly repo: string;
  readonly commit: string;
}

/** The record inside a pristine repository naming what it holds. */
const PIN_FILE = 'fireforge-pin.json';

const PinRecord = s.object({
  firefox: s.unknown(),
  commit: s.string({ pattern: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/ }),
  /** The archive the commit was imported from; absent in a record that predates it. */
  archive: s.object({ sha256: s.string({ pattern: /^[a-f0-9]{64}$/ }) }).optional(),
});
type PinRecord = Infer<typeof PinRecord>;

/** The metadata of the one commit an archive imports as. */
const IMPORT_COMMIT = {
  message: 'Initial Firefox source',
  identity: { name: 'FireForge', email: 'fireforge@localhost' },
  date: '2000-01-01T00:00:00Z',
} as const;

/** Repository settings whose host defaults would change the imported tree. */
const HOST_INDEPENDENT_CONFIG = [
  ['core.precomposeunicode', 'false'],
  ['core.filemode', 'true'],
  ['core.symlinks', 'true'],
] as const;

/** An import takes minutes; a second command for the same pin waits for it. */
const IMPORT_WAIT_MS = 60 * 60 * 1000;

/** What a record proves about the archive its commit was imported from. */
function evidenceOf(record: PinRecord): {
  sha256: string | undefined;
  verification: 'pinned' | 'published' | 'unverified';
} {
  const stored = isRecord(record.firefox) ? record.firefox : {};
  const pinned = typeof stored['sha256'] === 'string' ? stored['sha256'] : undefined;
  return {
    // A pinned digest was checked against the archive, so it is the archive's.
    sha256: record.archive?.sha256 ?? pinned,
    // Without a pinned digest an import either matched the published one or,
    // only where the project allowed it, was trusted on TLS alone.
    verification:
      pinned !== undefined
        ? 'pinned'
        : stored['allowUnverifiedDownload'] === true
          ? 'unverified'
          : 'published',
  };
}

/** Why a record does not meet the pin's verification requirements, or undefined when it does. */
function unmet(record: PinRecord, pin: FirefoxPin): string | undefined {
  const evidence = evidenceOf(record);
  if (pin.sha256 !== undefined) {
    if (evidence.sha256 === pin.sha256) return undefined;
    return evidence.sha256 === undefined
      ? `its import did not record the archive's digest, and firefox.sha256 requires ${pin.sha256}`
      : `it was imported from an archive with SHA-256 ${evidence.sha256}, not the pinned ${pin.sha256}`;
  }
  if (evidence.verification !== 'unverified' || pin.allowUnverifiedDownload) return undefined;
  return 'it was imported from an archive accepted without checking its digest, which firefox.allowUnverifiedDownload no longer allows';
}

type Lookup =
  | { kind: 'absent' }
  | { kind: 'found'; pristine: Pristine }
  | { kind: 'unmet'; pristine: Pristine; reason: string };

async function lookup(host: Pick<HostPaths, 'pristine'>, pin: FirefoxPin): Promise<Lookup> {
  const read = (repo: string): Promise<PinRecord | undefined> =>
    readJsonIfExists(join(repo, PIN_FILE), PinRecord, {
      code: 'pristine-invalid',
      exitCode: ExitCode.CONFIG_ERROR,
      hint: `Remove ${repo} and run "fireforge download" to import the source again.`,
    });
  const repo = join(host.pristine, pinKey(pin));
  const record = await read(repo);
  if (record !== undefined) {
    const pristine = { repo, commit: record.commit };
    const reason = unmet(record, pin);
    return reason === undefined ? { kind: 'found', pristine } : { kind: 'unmet', pristine, reason };
  }
  // A repository filed under the pin's key without its candidate serves the
  // pin when its record names exactly this archive.
  if (pin.candidate === undefined) return { kind: 'absent' };
  const earlier = join(host.pristine, pinKey({ product: pin.product, version: pin.version }));
  const stored = await read(earlier);
  return stored !== undefined && samePin(stored, pin)
    ? { kind: 'found', pristine: { repo: earlier, commit: stored.commit } }
    : { kind: 'absent' };
}

/**
 * The pristine repository of a pin when this host already has it and what
 * was recorded at its import meets the pin: the archive's digest equal to
 * `firefox.sha256` when the pin has one, and a digest that was verified
 * unless `firefox.allowUnverifiedDownload` is set. Reads nothing from the
 * network.
 *
 * @param host - The host locations
 * @param pin - The pin
 * @throws `pristine-invalid` (exit code 2) when the repository's record is
 *   malformed; `pristine-unsatisfied` (exit code 3) when the repository does
 *   not meet the pin, which `fireforge download` settles
 */
export async function findPristine(
  host: Pick<HostPaths, 'pristine'>,
  pin: FirefoxPin
): Promise<Pristine | undefined> {
  const found = await lookup(host, pin);
  if (found.kind === 'unmet') {
    throw new FireForgeError(
      'pristine-unsatisfied',
      `The pristine source of ${pinKey(pin)} does not meet this project's pin: ${found.reason}.`,
      {
        exitCode: ExitCode.DOWNLOAD_ERROR,
        hint: 'Run "fireforge download" to verify it again; the cached archive is used when this host still has it.',
      }
    );
  }
  return found.kind === 'found' ? found.pristine : undefined;
}

/** Whether a stored record names the archive of `pin`: product, version, candidate and digest. */
function samePin(record: PinRecord, pin: FirefoxPin): boolean {
  const stored = record.firefox;
  if (!isRecord(stored)) return false;
  const { sha256 } = evidenceOf(record);
  return (
    stored['product'] === pin.product &&
    stored['version'] === pin.version &&
    stored['candidate'] === pin.candidate &&
    sha256 !== undefined &&
    sha256 === pin.sha256
  );
}

/**
 * Imports an extracted source tree as a bare repository at `repo` with one
 * commit on `main`, and returns the commit.
 */
async function importTree(tree: string, repo: string): Promise<string> {
  const archived = await walkFiles(tree);
  // mach lint reads both ignore files, and a source archive ships only git's.
  const lintsIgnoreFiles = await exists(join(tree, 'tools', 'lint', 'ignorefile.yml'));
  const added: string[] = [];
  if (lintsIgnoreFiles && archived.includes('.gitignore') && !archived.includes('.hgignore')) {
    await copyFile(join(tree, '.gitignore'), join(tree, '.hgignore'));
    added.push('.hgignore');
  }
  await initRepository(tree);
  // File names are taken as the archive spells them on every host: git on
  // macOS would otherwise recompose decomposed Unicode names into another tree.
  for (const [key, value] of HOST_INDEPENDENT_CONFIG) await setConfig(tree, key, value);
  const commit = await commitTree(
    tree,
    await captureWorktree(tree, { base: null, includeIgnored: true }),
    IMPORT_COMMIT
  );
  await updateRef(tree, 'refs/heads/main', commit);

  // The commit is the source of record, so it must hold what the archive
  // holds, whatever upstream's own ignore rules would hide.
  const committed = new Set((await listTree(tree, commit)).map((entry) => entry.path));
  const expected = new Set([...archived, ...added]);
  const missing = archived.find((path) => !committed.has(path));
  const extra = [...committed].find((path) => !expected.has(path));
  if (missing !== undefined || extra !== undefined) {
    throw new FireForgeError(
      'pristine-archive-mismatch',
      missing !== undefined
        ? `The imported commit lacks archive file ${missing}`
        : `The imported commit holds ${extra ?? ''}, which the archive does not`,
      { exitCode: ExitCode.GIT_ERROR, hint: 'Report this: the import must reproduce the archive.' }
    );
  }
  await cloneRepository(tree, repo, { bare: true });
  return commit;
}

/** What {@link ensurePristine} can be told. */
export interface PristineOptions extends DownloadOptions {
  /**
   * The commit the project pins. An archive that imports as another commit
   * is refused and leaves no repository behind.
   */
  expectCommit?: string | undefined;
}

function commitMismatch(pin: FirefoxPin, expected: string, actual: string): FireForgeError {
  return new FireForgeError(
    'pristine-commit-mismatch',
    `The source archive of ${pinKey(pin)} imports as commit ${actual}, not the pinned ${expected}`,
    {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'The pin and the archive disagree: check firefox.version, firefox.candidate and source.pristineCommit.',
    }
  );
}

/**
 * The pristine repository of a pin, imported first when this host lacks it:
 * the archive is downloaded (or taken from the host cache), verified,
 * extracted and committed as one reproducible commit. Two commands asking
 * for the same pin import it once.
 *
 * @param host - The host locations
 * @param pin - The pin
 * @param options - See {@link PristineOptions}
 * @throws The download and extraction errors of `archive.ts` (exit code 3),
 *   `pristine-commit-mismatch` (exit code 2)
 */
export async function ensurePristine(
  host: HostPaths,
  pin: FirefoxPin,
  options: PristineOptions = {}
): Promise<Pristine> {
  const check = (pristine: Pristine): Pristine => {
    if (options.expectCommit !== undefined && options.expectCommit !== pristine.commit) {
      throw commitMismatch(pin, options.expectCommit, pristine.commit);
    }
    return pristine;
  };
  const present = await lookup(host, pin);
  if (present.kind === 'found') return check(present.pristine);

  const key = pinKey(pin);
  const lock = join(host.locks, `pristine-${key}`);
  return withLock(lock, { label: `pristine ${key}`, waitMs: IMPORT_WAIT_MS }, async () => {
    const imported = await lookup(host, pin);
    if (imported.kind === 'found') return check(imported.pristine);
    if (imported.kind === 'unmet') {
      options.onProgress?.(
        `The imported source of ${key} does not meet the pin (${imported.reason}); verifying and importing it again`
      );
    }

    const repo = join(host.pristine, key);
    const archive = await ensureArchive(host, pin, options);
    const archiveSha256 = await hashFile(archive);
    await ensureDir(host.pristine);
    const staging = tempPathFor(repo);
    const tree = `${staging}-tree`;
    try {
      options.onProgress?.('Extracting the source archive');
      await extractArchive(archive, tree);
      options.onProgress?.('Importing the source as one commit');
      const pristine = check({ repo, commit: await importTree(tree, staging) });
      const record = { firefox: pin, commit: pristine.commit, archive: { sha256: archiveSha256 } };
      if (imported.kind === 'unmet' && imported.pristine.commit === pristine.commit) {
        // The same commit again: the repository stays and its record is brought up to date.
        await writeJson(join(repo, PIN_FILE), record);
        return pristine;
      }
      await writeJson(join(staging, PIN_FILE), record);
      // What is at the final path either has no record (an import that never
      // finished) or holds another commit than the archive imports as.
      await remove(repo);
      await move(staging, repo);
      return pristine;
    } finally {
      await remove(tree);
      await remove(staging);
    }
  });
}

/**
 * Creates an engine: a git checkout of the pristine commit on branch `main`,
 * with its own objects, so it does not depend on the pristine repository
 * afterwards.
 *
 * @param pristine - The pristine repository
 * @param engineDir - The directory to create; absent or empty
 * @throws `engine-exists` when the directory holds anything
 */
export async function checkoutPristine(pristine: Pristine, engineDir: string): Promise<void> {
  if ((await listDir(engineDir)).length > 0) {
    throw new FireForgeError('engine-exists', `${engineDir} already exists and is not empty`, {
      exitCode: ExitCode.GENERAL_ERROR,
      hint: 'Move it away, or name another directory.',
    });
  }
  await cloneRepository(pristine.repo, engineDir);
  const head = await resolveRevision(engineDir, 'HEAD', 'commit');
  if (head !== pristine.commit) {
    await remove(engineDir);
    throw new FireForgeError(
      'pristine-invalid',
      `${pristine.repo} has ${head ?? 'no commit'} on its main branch, not the recorded ${pristine.commit}`,
      {
        exitCode: ExitCode.GIT_ERROR,
        hint: `Remove ${pristine.repo} and run "fireforge download" to import the source again.`,
      }
    );
  }
  // What a build writes into the engine is never source, whatever the
  // archive's own ignore rules say.
  await appendText(join(engineDir, '.git', 'info', 'exclude'), `/${OBJDIR_NAME}/\n/mozconfig\n`);
}

/** What {@link installProjectEngine} did. */
export interface EngineInstall {
  /** The project's `engine/`. */
  engineDir: string;
  /** An engine was there and has been replaced. */
  replaced: boolean;
  /**
   * The recovery ref in the new engine holding the replaced engine's
   * uncommitted state, when it had any.
   */
  recovery?: string;
}

/**
 * Makes a patch-mode project's `engine/` a fresh checkout of the pristine
 * commit, under the engine lock. An engine that is already there is replaced
 * only with `force`; its working-tree state is first saved as a recovery
 * snapshot, which is carried into the new engine. The old engine stays in
 * place until the new one is complete.
 *
 * @param project - The project
 * @param pristine - The pristine repository of its pin
 * @param options - `force`; `waitMs` for the engine lock; `beforeReplace`,
 *   run under that lock once an existing engine is about to be replaced, which
 *   leaves the engine alone by throwing
 * @throws `engine-exists` when there is an engine and `force` is not set
 */
export async function installProjectEngine(
  project: PatchProject,
  pristine: Pristine,
  options: {
    force?: boolean;
    waitMs?: number | undefined;
    beforeReplace?: (() => Promise<void>) | undefined;
  } = {}
): Promise<EngineInstall> {
  const engineDir = project.paths.engine;
  return withEngineLock(project, { command: 'download', waitMs: options.waitMs }, async () => {
    if ((await listDir(engineDir)).length === 0) {
      await checkoutPristine(pristine, engineDir);
      return { engineDir, replaced: false };
    }
    if (options.force !== true) {
      throw new FireForgeError('engine-exists', `${engineDir} already holds an engine`, {
        exitCode: ExitCode.GENERAL_ERROR,
        hint: 'Pass --force to replace it. Its uncommitted changes are kept as a recovery snapshot; its build is not.',
      });
    }
    await options.beforeReplace?.();
    const snapshot = (await isRepository(engineDir))
      ? await saveRecoverySnapshot(engineDir, { label: 'download' })
      : undefined;
    const replacement = tempPathFor(engineDir);
    const retired = tempPathFor(engineDir);
    try {
      await checkoutPristine(pristine, replacement);
      if (snapshot !== undefined) {
        await fetchCommit(replacement, engineDir, snapshot.commit);
        await updateRef(replacement, snapshot.ref, snapshot.commit);
      }
      await move(engineDir, retired);
      try {
        await move(replacement, engineDir);
      } catch (error: unknown) {
        await move(retired, engineDir);
        throw error;
      }
    } finally {
      await remove(replacement);
    }
    await remove(retired);
    return {
      engineDir,
      replaced: true,
      ...(snapshot === undefined ? {} : { recovery: snapshot.ref }),
    };
  });
}

/**
 * Reads files of the pristine commit.
 *
 * @param pristine - The pristine repository
 * @param paths - Engine-relative paths
 * @returns Content by path; a path the commit lacks is absent
 */
export async function readPristineFiles(
  pristine: Pristine,
  paths: readonly string[]
): Promise<Map<string, Buffer>> {
  const blobs = await readBlobs(
    pristine.repo,
    paths.map((path) => `${pristine.commit}:${path}`)
  );
  const files = new Map<string, Buffer>();
  for (const path of paths) {
    const content = blobs.get(`${pristine.commit}:${path}`);
    if (content !== undefined) files.set(path, content);
  }
  return files;
}

/**
 * Lists the files of the pristine commit, with their modes and blob ids.
 *
 * @param pristine - The pristine repository
 * @param paths - Limit the listing to these files or directories
 */
export function listPristineTree(
  pristine: Pristine,
  paths?: readonly string[]
): Promise<TreeEntry[]> {
  return listTree(pristine.repo, pristine.commit, paths === undefined ? {} : { paths });
}
