// SPDX-License-Identifier: EUPL-1.2
/**
 * Reads the objdir's mozpack install manifests to tell how an engine source
 * reaches the runtime a test runs against.
 *
 * mozbuild installs packaged files from manifests under
 * `obj-*\/_build_manifests/install/` and `obj-*\/faster/install_*`. Each
 * line after the version is a `\x1f`-separated entry: type 1 installs a
 * symlink to an absolute source, 2 copies it, 7 preprocesses it, and 5/6
 * are the pattern forms of 1/2 (`base`, `pattern`, `dest dir`). In a
 * non-Windows dev build most chrome and test files are type-1 symlinks back
 * into `engine/`, so an edit to such a file is already what the runtime
 * reads. `_test_files` is rewritten and installed by `mach test` itself on
 * every dispatch, so test files are restaged when a run starts.
 *
 * Every classification is conservative: an entry whose install base is
 * unknown, a symlink that does not resolve to the edited source, or an
 * unreadable manifest leaves the path classified as packaged.
 */

import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { escapeRegex } from '../utils/regex.js';

/** Install-manifest field separator. */
const FIELD_SEPARATOR = '\x1f';
/** mozpack entry types that install a symlink. */
const SYMLINK_TYPE = '1';
const PATTERN_SYMLINK_TYPE = '5';
const PATTERN_COPY_TYPE = '6';
/** Entry types with no source file (existence markers, inline content). */
const SOURCELESS_TYPES = new Set(['3', '4', '8']);
/** The manifest `mach test` writes and installs at every dispatch. */
const DISPATCH_MANIFEST = '_test_files';

interface InstallEntry {
  symlink: boolean;
  /** Absolute installed path, or undefined when the install base is unknown. */
  dest: string | undefined;
  /** Installed by `mach test` at dispatch rather than by the build. */
  atDispatch: boolean;
}

interface PatternEntry {
  symlink: boolean;
  /** Engine-relative directory the pattern matches beneath. */
  base: string;
  pattern: RegExp;
  /** Absolute install directory, or undefined when the install base is unknown. */
  destDir: string | undefined;
  atDispatch: boolean;
}

/** Parsed install manifests of one objdir. */
export interface InstallManifestIndex {
  explicit: Map<string, InstallEntry[]>;
  patterns: PatternEntry[];
  engineRoots: string[];
}

/** How an engine source reaches the runtime. */
export type RuntimeDelivery =
  /** Every installed copy is a symlink to the source: edits are already live. */
  | 'live'
  /** Installed only by `mach test` at dispatch, which restages it. */
  | 'at-dispatch'
  /** At least one installed copy is a real copy (or unverifiable). */
  | 'packaged'
  /** No install manifest names it. */
  | 'unlisted';

/** Converts a mozpack pattern (`*`, `**`, `?`) to an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp | undefined {
  if (pattern.split('/').includes('..')) return undefined;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? '';
    if (pattern.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
}

function engineRelative(roots: readonly string[], absolute: string): string | undefined {
  const normalized = normalizePathSlashes(absolute);
  for (const root of roots) {
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return undefined;
}

/** Install base (objdir-relative) of a `_build_manifests/install/<name>` manifest. */
function buildManifestBase(name: string): string | undefined {
  if (name === DISPATCH_MANIFEST || name === '_tests') return '_tests';
  const dist = /^dist_(.+)$/.exec(name);
  return dist ? `dist/${dist[1] ?? ''}` : undefined;
}

/** `faster/install_*` manifest name → install base, from `faster/Makefile`. */
async function fasterManifestBases(objDirPath: string): Promise<Map<string, string>> {
  const bases = new Map<string, string>();
  const makefile = await readFile(join(objDirPath, 'faster', 'Makefile'), 'utf8').catch(() => '');
  const line = /^INSTALL_MANIFESTS\s*=(.*)$/m.exec(makefile)?.[1] ?? '';
  for (const base of line.trim().split(/\s+/).filter(Boolean)) {
    bases.set(`install_${base.replaceAll('/', '_')}`, base);
  }
  // `mach build faster` installs a merged copy of the per-directory
  // manifests, rooted at dist/bin.
  bases.set('unified_install_dist_bin', 'dist/bin');
  return bases;
}

function parseManifest(
  index: InstallManifestIndex,
  content: string,
  installRoot: string | undefined,
  atDispatch: boolean
): void {
  for (const line of content.split('\n').slice(1)) {
    const fields = line.split(FIELD_SEPARATOR);
    const [type = '', dest = '', source = ''] = fields;
    if (SOURCELESS_TYPES.has(type) || source === '') continue;
    const base = engineRelative(index.engineRoots, source);
    if (base === undefined) continue;
    if (type === PATTERN_SYMLINK_TYPE || type === PATTERN_COPY_TYPE) {
      const pattern = patternToRegExp(fields[3] ?? '');
      const destDir = fields[4];
      if (pattern === undefined) continue;
      index.patterns.push({
        symlink: type === PATTERN_SYMLINK_TYPE,
        base,
        pattern,
        destDir:
          installRoot === undefined || destDir === undefined
            ? undefined
            : join(installRoot, destDir),
        atDispatch,
      });
      continue;
    }
    const entries = index.explicit.get(base) ?? [];
    entries.push({
      symlink: type === SYMLINK_TYPE,
      dest: installRoot === undefined ? undefined : join(installRoot, dest),
      atDispatch,
    });
    index.explicit.set(base, entries);
  }
}

async function readManifests(
  dir: string,
  baseFor: (name: string) => string | undefined,
  index: InstallManifestIndex,
  objDirPath: string
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name.startsWith('.') || name.endsWith('.track') || name === 'Makefile') continue;
    const content = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    if (content === undefined) continue;
    const base = baseFor(name);
    parseManifest(
      index,
      content,
      base === undefined ? undefined : join(objDirPath, base),
      name === DISPATCH_MANIFEST
    );
  }
  return true;
}

/**
 * Loads every install manifest of `objDir`. Undefined when neither manifest
 * directory is readable, i.e. nothing can be classified.
 *
 * @param engineDir - Absolute engine directory
 * @param objDir - Objdir name under the engine directory
 */
export async function loadInstallManifestIndex(
  engineDir: string,
  objDir: string
): Promise<InstallManifestIndex | undefined> {
  const objDirPath = join(engineDir, objDir);
  const roots = [normalizePathSlashes(resolve(engineDir))];
  const real = await realpath(engineDir).catch(() => undefined);
  if (real !== undefined && !roots.includes(normalizePathSlashes(real))) {
    roots.push(normalizePathSlashes(real));
  }
  const index: InstallManifestIndex = { explicit: new Map(), patterns: [], engineRoots: roots };
  try {
    const fasterBases = await fasterManifestBases(objDirPath);
    const readBuild = await readManifests(
      join(objDirPath, '_build_manifests', 'install'),
      buildManifestBase,
      index,
      objDirPath
    );
    const readFaster = await readManifests(
      join(objDirPath, 'faster'),
      (name) => fasterBases.get(name),
      index,
      objDirPath
    );
    return readBuild || readFaster ? index : undefined;
  } catch (error: unknown) {
    verbose(`Install manifests unreadable under ${objDir}: ${toError(error).message}`);
    return undefined;
  }
}

/** True when `dest` is a symlink resolving to the same file as `source`. */
async function isSymlinkTo(dest: string | undefined, source: string): Promise<boolean> {
  if (dest === undefined) return false;
  try {
    if (!(await lstat(dest)).isSymbolicLink()) return false;
    return (await realpath(dest)) === (await realpath(source));
  } catch {
    return false;
  }
}

/**
 * Classifies how `relPath` reaches the runtime. See {@link RuntimeDelivery}.
 *
 * @param index - Index from {@link loadInstallManifestIndex}
 * @param engineDir - Absolute engine directory
 * @param relPath - Engine-relative POSIX path
 */
export async function classifyRuntimeDelivery(
  index: InstallManifestIndex,
  engineDir: string,
  relPath: string
): Promise<RuntimeDelivery> {
  const entries = [...(index.explicit.get(relPath) ?? [])];
  for (const pattern of index.patterns) {
    if (!relPath.startsWith(`${pattern.base}/`)) continue;
    const rest = relPath.slice(pattern.base.length + 1);
    if (!pattern.pattern.test(rest)) continue;
    entries.push({
      symlink: pattern.symlink,
      dest: pattern.destDir === undefined ? undefined : join(pattern.destDir, rest),
      atDispatch: pattern.atDispatch,
    });
  }
  if (entries.length === 0) return 'unlisted';
  if (entries.every((entry) => entry.atDispatch)) return 'at-dispatch';
  const source = join(engineDir, relPath);
  for (const entry of entries) {
    if (entry.atDispatch) continue;
    if (!entry.symlink || !(await isSymlinkTo(entry.dest, source))) return 'packaged';
  }
  return 'live';
}

/**
 * True when any install-manifest entry installs something from at or
 * beneath the engine-relative directory `dir`, or a pattern entry's base
 * contains it.
 */
export function installsFromDirectory(index: InstallManifestIndex, dir: string): boolean {
  const prefix = dir.replace(/\/+$/, '');
  const under = (path: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
  for (const source of index.explicit.keys()) if (under(source)) return true;
  return index.patterns.some(
    (pattern) => under(pattern.base) || prefix.startsWith(`${pattern.base}/`)
  );
}
