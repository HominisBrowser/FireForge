// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-path packaging-coverage anchors for scoped `fireforge test --build`.
 *
 * A scoped build used to carry one claim anchored to the whole engine, so
 * any edit outside the new scope (a peer's, on a shared engine, nearly
 * always) replaced it. Each staged request path now carries its own anchor
 * restricted to its own staging inputs, and a claim is dropped only when
 * one of those inputs changed.
 *
 * The staging inputs of a request path are its manifest directory (the
 * nearest directory at or above it that holds a test manifest) plus every
 * path a manifest there names outside that directory (`support-files`,
 * `head`, `!/`-rooted shared fixtures). Without the full mozbuild graph
 * that is the closest sound boundary: an edit outside it cannot change
 * what the harness stages for that path.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { getNodeErrorCode, toError } from '../utils/errors.js';
import { sha256Hex } from '../utils/hash.js';
import { verbose } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import {
  type CoverageAnchor,
  type CoverageRecord,
  DELETED_FILE_FINGERPRINT,
} from './build-baseline-types.js';
import { getHead, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

/**
 * Basenames of the test manifests whose entries decide what a packaged test
 * runtime stages.
 */
const TEST_MANIFEST_BASENAMES = new Set([
  'xpcshell.toml',
  'xpcshell.ini',
  'browser.toml',
  'browser.ini',
  'mochitest.toml',
  'mochitest.ini',
  'chrome.toml',
  'chrome.ini',
  'a11y.toml',
  'a11y.ini',
]);

/** Directory entries a directory request's manifest walk visits at most. */
const MAX_WALK_ENTRIES = 5000;

/**
 * Hex-encoded SHA-256 of an engine-relative file, matching the digest the
 * baseline writer produces. A missing file hashes to
 * {@link DELETED_FILE_FINGERPRINT}. `undefined` on any other IO error,
 * which every caller treats as "cannot prove unchanged".
 * @param engineDir - Path to the engine directory
 * @param relPath - Engine-relative POSIX path
 */
export async function hashEngineFile(
  engineDir: string,
  relPath: string
): Promise<string | undefined> {
  try {
    return sha256Hex(await readFile(join(engineDir, relPath)));
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return DELETED_FILE_FINGERPRINT;
    verbose(`Coverage anchor: could not hash ${relPath} — ${toError(error).message}`);
    return undefined;
  }
}

/** True for a test manifest path (by basename). */
export function isTestManifestPath(path: string): boolean {
  return TEST_MANIFEST_BASENAMES.has(posix.basename(path));
}

/** Normalizes a request path: forward slashes, no `./`, no trailing slash. */
export function normalizeRequestPath(path: string): string {
  const normalized = posix.normalize(normalizePathSlashes(path.trim())).replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

/** True when `file` is `prefix` or sits beneath it. The empty prefix is the whole tree. */
export function isUnderPath(file: string, prefix: string): boolean {
  return prefix === '' || file === prefix || file.startsWith(`${prefix}/`);
}

/**
 * Engine state one coverage decision reads. Shared across every anchor a
 * decision verifies, so the git probes run once and each file is hashed
 * once.
 */
export interface EngineContentState {
  engineDir: string;
  /** Current engine HEAD, or undefined for an unborn branch. */
  head: string | undefined;
  /** Engine-relative paths dirty against HEAD (tracked and untracked). */
  dirty: ReadonlySet<string>;
  hashes: Map<string, Promise<string | undefined>>;
  diffs: Map<string, Promise<ReadonlySet<string> | undefined>>;
}

/**
 * Reads HEAD and the dirty set. Throws on a git failure other than an
 * unborn HEAD: callers treat that as "nothing can be proven unchanged".
 * @param engineDir - Path to the engine directory
 */
export async function readEngineContentState(engineDir: string): Promise<EngineContentState> {
  let head: string | undefined;
  try {
    head = await getHead(engineDir);
  } catch (error: unknown) {
    if (!isMissingHeadError(error)) throw error;
  }
  const dirty = new Set<string>();
  if (head !== undefined) {
    for (const line of (await git(['diff', '--name-only', 'HEAD'], engineDir)).split('\n')) {
      if (line.trim()) dirty.add(line.trim());
    }
  }
  for (const file of await getUntrackedFiles(engineDir)) dirty.add(file);
  return { engineDir, head, dirty, hashes: new Map(), diffs: new Map() };
}

function liveHash(state: EngineContentState, path: string): Promise<string | undefined> {
  let pending = state.hashes.get(path);
  if (pending === undefined) {
    pending = hashEngineFile(state.engineDir, path);
    state.hashes.set(path, pending);
  }
  return pending;
}

/** Paths committed between `from` and HEAD, or undefined when `from` cannot be diffed. */
function committedSince(
  state: EngineContentState,
  from: string
): Promise<ReadonlySet<string> | undefined> {
  let pending = state.diffs.get(from);
  if (pending === undefined) {
    pending = git(['diff', '--name-only', `${from}..HEAD`], state.engineDir).then(
      (output) =>
        new Set(
          output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        ),
      (error: unknown) => {
        verbose(`Coverage anchor: cannot diff ${from}..HEAD — ${toError(error).message}`);
        return undefined;
      }
    );
    state.diffs.set(from, pending);
  }
  return pending;
}

/**
 * Paths whose content may differ from the anchor, restricted to `inputs`
 * (undefined: the whole tree) and excluding `rebuilt` paths. Undefined when
 * the anchor cannot be compared at all (no usable HEAD on either side).
 */
async function candidatePaths(
  state: EngineContentState,
  anchor: CoverageAnchor,
  inputs: readonly string[] | undefined,
  rebuilt: readonly string[]
): Promise<Set<string> | undefined> {
  if (state.head === undefined || anchor.engineHeadSha === '') return undefined;
  const inScope = (file: string): boolean =>
    (inputs === undefined || inputs.some((input) => isUnderPath(file, input))) &&
    !rebuilt.some((path) => isUnderPath(file, path));
  const candidates = new Set<string>();
  if (state.head !== anchor.engineHeadSha) {
    const committed = await committedSince(state, anchor.engineHeadSha);
    if (committed === undefined) return undefined;
    for (const file of committed) if (inScope(file)) candidates.add(file);
  }
  for (const file of state.dirty) if (inScope(file)) candidates.add(file);
  for (const file of Object.keys(anchor.fingerprints)) if (inScope(file)) candidates.add(file);
  return candidates;
}

/**
 * Inputs whose live content differs from what the anchor staged, sorted.
 * Undefined when the anchor cannot be compared, which every caller treats as
 * "changed".
 *
 * @param state - Engine state from {@link readEngineContentState}
 * @param anchor - The claim's anchor
 * @param inputs - Staging inputs to compare, or undefined for the whole tree
 * @param rebuilt - Request paths the current build stages afresh
 */
export async function findChangedInputs(
  state: EngineContentState,
  anchor: CoverageAnchor,
  inputs: readonly string[] | undefined,
  rebuilt: readonly string[] = []
): Promise<string[] | undefined> {
  const candidates = await candidatePaths(state, anchor, inputs, rebuilt);
  if (candidates === undefined) return undefined;
  const changed: string[] = [];
  for (const file of candidates) {
    const recorded = anchor.fingerprints[file];
    // Not recorded: the staged copy is the anchor HEAD's, and the file is
    // a candidate only because it was committed or dirtied since.
    if (recorded === undefined || (await liveHash(state, file)) !== recorded) changed.push(file);
  }
  return changed.sort();
}

/**
 * The anchor after the current build restaged `rebuilt`: recorded content
 * for those paths becomes their live content. Undefined when that content
 * cannot be read or the anchor cannot be compared.
 */
export async function refreshAnchor<T extends CoverageAnchor>(
  state: EngineContentState,
  anchor: T,
  rebuilt: readonly string[]
): Promise<T | undefined> {
  const everything = await candidatePaths(state, anchor, undefined, []);
  if (everything === undefined) return undefined;
  const restaged = (file: string): boolean => rebuilt.some((path) => isUnderPath(file, path));
  const fingerprints: Record<string, string> = {};
  for (const [file, hash] of Object.entries(anchor.fingerprints)) {
    if (!restaged(file)) fingerprints[file] = hash;
  }
  for (const file of everything) {
    // A restaged file equal to the anchor HEAD's content needs no entry.
    if (!restaged(file) || (state.head === anchor.engineHeadSha && !state.dirty.has(file))) {
      continue;
    }
    const live = await liveHash(state, file);
    if (live === undefined) return undefined;
    fingerprints[file] = live;
  }
  return { ...anchor, fingerprints };
}

/** Nearest directory at or above `dir` that holds a test manifest, or undefined. */
async function findManifestDirectory(engineDir: string, dir: string): Promise<string | undefined> {
  for (let current = dir; ; current = posix.dirname(current)) {
    const base = current === '.' ? '' : current;
    try {
      const entries = await readdir(join(engineDir, base));
      if (entries.some((entry) => TEST_MANIFEST_BASENAMES.has(entry))) return base;
    } catch {
      // A missing directory has no manifest. Keep walking up.
    }
    if (base === '') return undefined;
  }
}

/** Test manifests at or beneath `dir`, bounded by {@link MAX_WALK_ENTRIES}. */
async function findManifestsBeneath(engineDir: string, dir: string): Promise<string[]> {
  const manifests: string[] = [];
  const pending = [dir];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_WALK_ENTRIES) {
    const current = pending.pop() ?? '';
    let entries;
    try {
      entries = await readdir(join(engineDir, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const path = current ? `${current}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (TEST_MANIFEST_BASENAMES.has(entry.name)) manifests.push(path);
    }
  }
  return manifests;
}

/**
 * Engine-relative paths a manifest names outside its own directory. Bare
 * names stay inside it. `!/` and `/` prefixes are engine-root relative, as
 * in mozbuild manifests. A glob keeps the directory part before its first
 * wildcard segment.
 */
export function manifestExternalReferences(manifestPath: string, text: string): string[] {
  const dir = posix.dirname(manifestPath);
  const refs: string[] = [];
  for (const token of text.match(/[\w.!~@+\-/*?{}]+/g) ?? []) {
    if (!token.includes('/') || token.includes('//')) continue;
    const rooted = token.startsWith('!/')
      ? token.slice(2)
      : token.startsWith('/')
        ? token.slice(1)
        : undefined;
    const resolved = rooted === undefined ? posix.join(dir, token) : posix.normalize(rooted);
    const segments = resolved.split('/');
    const wildcard = segments.findIndex((segment) => /[*?{}]/.test(segment));
    const path = normalizeRequestPath(
      wildcard >= 0 ? segments.slice(0, wildcard).join('/') : resolved
    );
    if (path === '' || path.startsWith('..') || isUnderPath(path, dir)) continue;
    refs.push(path);
  }
  return refs;
}

/** Drops entries that sit beneath another entry, then sorts. */
function collapsePaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)].sort();
  return unique.filter(
    (path) => !unique.some((other) => other !== path && isUnderPath(path, other))
  );
}

/**
 * Staging inputs of one request path. See the module comment.
 * @param engineDir - Path to the engine directory
 * @param requestPath - Engine-relative request path (file or directory)
 */
export async function collectStagingInputs(
  engineDir: string,
  requestPath: string
): Promise<string[]> {
  const path = normalizeRequestPath(requestPath);
  let isDirectory = false;
  try {
    isDirectory = (await stat(join(engineDir, path))).isDirectory();
  } catch {
    // A missing request path is staged by nothing. Its directory still decides.
  }
  const start = isDirectory ? path : posix.dirname(path);
  const base = await findManifestDirectory(engineDir, start === '.' ? '' : start);
  const fallback = start === '.' || start === '' ? path : start;
  const root = base === undefined || base === '' ? fallback : base;
  const manifests = new Set<string>();
  for (const entry of await readdir(join(engineDir, root)).catch(() => [])) {
    if (TEST_MANIFEST_BASENAMES.has(entry)) manifests.add(`${root}/${entry}`);
  }
  if (isDirectory) {
    for (const manifest of await findManifestsBeneath(engineDir, path)) manifests.add(manifest);
  }
  const inputs = [root, path];
  for (const manifest of manifests) {
    try {
      const text = await readFile(join(engineDir, manifest), 'utf8');
      inputs.push(...manifestExternalReferences(manifest, text));
    } catch (error: unknown) {
      verbose(`Coverage anchor: cannot read ${manifest} — ${toError(error).message}`);
    }
  }
  return collapsePaths(inputs);
}

/**
 * Records the anchor of a request path this build staged. Undefined when
 * HEAD is unborn or an input's content cannot be read: the path is still
 * claimed, and later retention falls back to the baseline-wide anchor.
 *
 * @param state - Engine state after the build
 * @param requestPath - Engine-relative request path
 * @param mozconfigHash - Hash of the mozconfig the build configured with
 */
export async function createCoverageRecord(
  state: EngineContentState,
  requestPath: string,
  mozconfigHash: string
): Promise<CoverageRecord | undefined> {
  if (state.head === undefined) return undefined;
  const inputs = await collectStagingInputs(state.engineDir, requestPath);
  return narrowAnchor(
    state,
    { engineHeadSha: state.head, mozconfigHash, fingerprints: {} },
    inputs,
    [...state.dirty]
  );
}

/**
 * Restricts an anchor to `inputs`. `extraDirty` adds paths whose live content
 * becomes the recorded one (the dirty set of a record being created).
 */
export async function narrowAnchor(
  state: EngineContentState,
  anchor: CoverageAnchor,
  inputs: string[],
  extraDirty: readonly string[] = []
): Promise<CoverageRecord | undefined> {
  const fingerprints: Record<string, string> = {};
  for (const [file, hash] of Object.entries(anchor.fingerprints)) {
    if (inputs.some((input) => isUnderPath(file, input))) fingerprints[file] = hash;
  }
  for (const file of extraDirty) {
    if (!inputs.some((input) => isUnderPath(file, input))) continue;
    const live = await liveHash(state, file);
    if (live === undefined) return undefined;
    fingerprints[file] = live;
  }
  return { ...anchor, fingerprints, inputs };
}
