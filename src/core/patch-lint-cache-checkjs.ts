// SPDX-License-Identifier: EUPL-1.2
/**
 * The checkJs part of the per-patch lint cache key.
 *
 * A patch's checkJs verdict depends on more than the files it owns. Its
 * `.sys.mjs` modules are checked in one program that resolves every
 * patch-owned `.sys.mjs` in the queue, and each of its test scripts in a
 * program that also loads the directory's patch-owned `head*.js`, the
 * modules the queue creates up to the test's own patch, the targets of a
 * reviewed `checkJsCompilerOptions.paths` mapping and, for the hint text,
 * the unmanaged companions a head pulls in. Which modules a test can
 * resolve depends on the queue order. A key over only the patch's own
 * files replays a verdict after another patch's module changed, and keeps
 * replaying a red after that module was restored byte for byte.
 *
 * {@link checkJsWorldDigest} hashes that world: the ordered queue (each
 * patch's created files, and the test scripts it modifies), the content of
 * every file in the union of those programs, and the TypeScript version.
 * The digest is shared by every checkJs-relevant patch in a run, so a
 * change anywhere in the world misses every such patch. That costs no
 * extra program build: the first miss builds the queue-wide program, and
 * every later miss slices from it.
 *
 * Memoised per queue context, which is one run's snapshot: file contents
 * are hashed once per context, and the digest is recomputed only after an
 * in-place entry update (see `invalidateNewFileCreatorsCache`). Engine
 * edits made while a context is alive are not observed.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import type { PatchLintConfig } from '../types/config.js';
import { sha256Hex } from '../utils/hash.js';
import { normalizePathSlashes } from '../utils/paths.js';
import type { PatchQueueContext } from './patch-lint-cross.js';
import { collectNewFileCreatorsByPath } from './patch-lint-cross.js';
import { isTestScriptFile } from './patch-lint-ownership.js';
import { collectUnmanagedCompanions } from './patch-lint-unmanaged-companion.js';

/** Files visited under one wildcard `paths` target before giving up on it. */
const PATHS_TARGET_WALK_LIMIT = 10_000;

const HEAD_SCRIPT = /^head(?:_.*)?\.js$/;

/** Content hashes per run, keyed by absolute path. Survives entry updates. */
const fileHashMemo = new WeakMap<PatchQueueContext, Map<string, Promise<string | null>>>();

/** Digests per creators map, which an in-place entry update replaces. */
const digestMemo = new WeakMap<object, Map<string, Promise<string>>>();

let typescriptVersion: Promise<string | null> | undefined;

/**
 * True when a patch that has `file` among its affected files can carry a
 * checkJs verdict: a `.sys.mjs` module, or a test script when
 * `patchLint.checkJsTestFiles` is on.
 */
export function isCheckJsCacheRelevant(file: string, patchLint: PatchLintConfig): boolean {
  return (
    file.endsWith('.sys.mjs') || (patchLint.checkJsTestFiles === true && isTestScriptFile(file))
  );
}

async function readTypescriptVersion(): Promise<string | null> {
  try {
    return (await import('typescript')).version;
  } catch {
    return null;
  }
}

function hashFile(ctx: PatchQueueContext, absolute: string): Promise<string | null> {
  let perRun = fileHashMemo.get(ctx);
  if (!perRun) {
    perRun = new Map();
    fileHashMemo.set(ctx, perRun);
  }
  let pending = perRun.get(absolute);
  if (!pending) {
    pending = readFile(absolute).then(
      (content) => sha256Hex(content),
      () => null
    );
    perRun.set(absolute, pending);
  }
  return pending;
}

/**
 * Engine-relative files a wildcard `paths` target can resolve to: the files
 * under the target's static directory that match its prefix and suffix.
 * Returns undefined when the walk passes {@link PATHS_TARGET_WALK_LIMIT}
 * (a target rooted high in the tree), so the key falls back to the target
 * string alone instead of walking Firefox.
 */
async function expandPathsTarget(engineDir: string, target: string): Promise<string[] | undefined> {
  const star = target.indexOf('*');
  if (star === -1) return [target];
  const prefix = target.slice(0, star);
  const suffix = target.slice(star + 1);
  const staticDir = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  const matches: string[] = [];
  const pending = [resolve(engineDir, staticDir)];
  let visited = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > PATHS_TARGET_WALK_LIMIT) return undefined;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      const rel = normalizePathSlashes(relative(engineDir, absolute));
      if (
        rel.length >= prefix.length + suffix.length &&
        rel.startsWith(prefix) &&
        rel.endsWith(suffix)
      ) {
        matches.push(rel);
      }
    }
  }
  return matches;
}

/** The queue order part of the digest: what each patch creates, in order. */
function queueShape(ctx: PatchQueueContext): unknown[] {
  return ctx.entries.map((entry) => [
    entry.filename,
    [...new Set([...entry.newFiles.keys(), ...entry.createdFiles])].sort(),
    [...entry.modifiedFileAdditions.keys()].filter(isTestScriptFile).sort(),
  ]);
}

async function computeDigest(
  engineDir: string,
  patchLint: PatchLintConfig,
  ctx: PatchQueueContext,
  created: readonly string[]
): Promise<string> {
  const universe = new Set<string>();
  for (const file of created) {
    if (file.endsWith('.mjs')) universe.add(file);
  }
  const tests = created.filter(isTestScriptFile);
  if (patchLint.checkJsTestFiles === true) {
    for (const file of tests) {
      if (HEAD_SCRIPT.test(file.slice(file.lastIndexOf('/') + 1))) universe.add(file);
    }
    const companions = await collectUnmanagedCompanions(engineDir, tests, new Set(tests));
    for (const companion of companions) universe.add(companion.file);
  }
  const unwalked: string[] = [];
  for (const targets of Object.values(patchLint.checkJsCompilerOptions?.paths ?? {})) {
    for (const target of targets) {
      const expanded = await expandPathsTarget(engineDir, target);
      if (expanded === undefined) unwalked.push(target);
      else for (const file of expanded) universe.add(file);
    }
  }

  const files = [...universe].sort();
  const hashes = await Promise.all(files.map((file) => hashFile(ctx, resolve(engineDir, file))));
  typescriptVersion ??= readTypescriptVersion();
  return sha256Hex(
    JSON.stringify({
      queue: queueShape(ctx),
      files: files.map((file, index) => [file, hashes[index] ?? null]),
      unwalkedPathsTargets: unwalked.sort(),
      typescript: await typescriptVersion,
    })
  );
}

/**
 * Digest of everything outside a patch's own files that its per-patch
 * checkJs verdict can depend on. See the module docs for what it covers
 * and how it is memoised.
 *
 * @param engineDir - Absolute engine directory the programs read
 * @param patchLint - The resolved `patchLint` block
 * @param ctx - The run's queue context
 */
export function checkJsWorldDigest(
  engineDir: string,
  patchLint: PatchLintConfig,
  ctx: PatchQueueContext
): Promise<string> {
  const creators = collectNewFileCreatorsByPath(ctx);
  let perCreators = digestMemo.get(creators);
  if (!perCreators) {
    perCreators = new Map();
    digestMemo.set(creators, perCreators);
  }
  const memoKey = JSON.stringify([
    engineDir,
    patchLint.checkJsTestFiles === true,
    patchLint.checkJsCompilerOptions?.paths ?? null,
  ]);
  let digest = perCreators.get(memoKey);
  if (!digest) {
    const created = new Set(creators.keys());
    for (const entry of ctx.entries) {
      for (const file of entry.newFiles.keys()) created.add(file);
    }
    digest = computeDigest(engineDir, patchLint, ctx, [...created].sort());
    perCreators.set(memoKey, digest);
  }
  return digest;
}
