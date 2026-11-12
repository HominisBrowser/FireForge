// SPDX-License-Identifier: EUPL-1.2
/**
 * How an engine source file reaches the built browser, read from the object
 * directory's install manifests (`_build_manifests/install/*` and
 * `faster/install_*`).
 *
 * A manifest is a version line followed by entries whose fields are
 * separated by `\x1f`: type 1 installs a symlink to an absolute source, 2
 * copies it, 7 preprocesses it, and 5 and 6 are the pattern forms of 1 and 2
 * (`base`, `pattern`, `destination directory`). Outside Windows most chrome
 * files of a development build are symlinks back into the engine, so an edit
 * to one is already what the browser reads. `_test_files` is rewritten and
 * installed by `mach test` itself on every run.
 *
 * Every answer errs toward "packaged": an entry whose install base is
 * unknown, or a symlink that does not resolve to the source, counts as a copy.
 */
import { join } from 'node:path';

import {
  listDir,
  pathInfo,
  readText,
  readTextIfExists,
  realPath,
  toPosixPath,
} from '../kernel/fs.js';
import { globToRegExp } from '../kernel/glob.js';

/** How a source file reaches the built browser. */
export type Delivery =
  /** Every installed copy is a symlink to the source: an edit is already live. */
  | 'live'
  /** Installed only by `mach test` when a run starts. */
  | 'at-test'
  /** At least one installed copy is a real copy, or cannot be checked. */
  | 'packaged'
  /** No install manifest names it. */
  | 'unlisted';

interface Install {
  symlink: boolean;
  /** Absolute installed path, or undefined when the manifest's install base is unknown. */
  destination: string | undefined;
  atTest: boolean;
}

interface PatternInstall extends Install {
  /** Engine-relative directory the pattern applies beneath. */
  base: string;
  pattern: RegExp;
}

/** The parsed install manifests of one object directory. */
export interface InstallIndex {
  files: Map<string, Install[]>;
  patterns: PatternInstall[];
}

const SEPARATOR = '\x1f';
/** Entry types that carry no source file. */
const SOURCELESS = new Set(['3', '4', '8']);
/** The manifest `mach test` installs at the start of every run. */
const TEST_MANIFEST = '_test_files';

function parse(
  index: InstallIndex,
  content: string,
  roots: readonly string[],
  manifest: { base: string | undefined; atTest: boolean }
): void {
  for (const line of content.split('\n').slice(1)) {
    const fields = line.split(SEPARATOR);
    const [type = '', destination = '', source = ''] = fields;
    if (SOURCELESS.has(type) || source === '') continue;
    const absolute = toPosixPath(source);
    const root = roots.find((candidate) => absolute.startsWith(`${candidate}/`));
    if (root === undefined) continue;
    const path = absolute.slice(root.length + 1);
    const at = (relative: string | undefined): string | undefined =>
      manifest.base === undefined || relative === undefined
        ? undefined
        : join(manifest.base, relative);
    if (type === '5' || type === '6') {
      const pattern = fields[3] ?? '';
      if (pattern.split('/').includes('..')) continue;
      index.patterns.push({
        symlink: type === '5',
        base: path,
        pattern: globToRegExp(pattern),
        destination: at(fields[4]),
        atTest: manifest.atTest,
      });
      continue;
    }
    const installs = index.files.get(path) ?? [];
    installs.push({ symlink: type === '1', destination: at(destination), atTest: manifest.atTest });
    index.files.set(path, installs);
  }
}

/**
 * Reads the install manifests of an object directory.
 *
 * @param engineDir - The engine the object directory was built from
 * @param objDir - The object directory
 * @returns Undefined when it has no manifests, so nothing can be told
 */
export async function readInstallIndex(
  engineDir: string,
  objDir: string
): Promise<InstallIndex | undefined> {
  const roots = [...new Set([toPosixPath(engineDir), toPosixPath(await realPath(engineDir))])];
  const index: InstallIndex = { files: new Map(), patterns: [] };
  const readAll = async (
    directory: string,
    baseOf: (name: string) => string | undefined
  ): Promise<number> => {
    let read = 0;
    for (const entry of await listDir(directory)) {
      const { name } = entry;
      if (entry.kind !== 'file' || name.startsWith('.') || name.endsWith('.track')) continue;
      if (name === 'Makefile') continue;
      const base = baseOf(name);
      parse(index, await readText(join(directory, name)), roots, {
        base: base === undefined ? undefined : join(objDir, base),
        atTest: name === TEST_MANIFEST,
      });
      read += 1;
    }
    return read;
  };
  const build = await readAll(join(objDir, '_build_manifests', 'install'), (name) =>
    name === TEST_MANIFEST || name === '_tests'
      ? '_tests'
      : name.startsWith('dist_')
        ? `dist/${name.slice('dist_'.length)}`
        : undefined
  );
  // The faster backend names each manifest after its install base, which its Makefile lists.
  const makefile = (await readTextIfExists(join(objDir, 'faster', 'Makefile'))) ?? '';
  const bases = new Map([['unified_install_dist_bin', 'dist/bin']]);
  for (const base of (/^INSTALL_MANIFESTS\s*=(.*)$/m.exec(makefile)?.[1] ?? '')
    .trim()
    .split(/\s+/)) {
    if (base !== '') bases.set(`install_${base.replaceAll('/', '_')}`, base);
  }
  const faster = await readAll(join(objDir, 'faster'), (name) => bases.get(name));
  return build + faster > 0 ? index : undefined;
}

async function linksTo(destination: string | undefined, source: string): Promise<boolean> {
  if (destination === undefined) return false;
  try {
    if ((await pathInfo(destination))?.kind !== 'symlink') return false;
    return (await realPath(destination)) === (await realPath(source));
  } catch {
    return false;
  }
}

/**
 * How one engine file reaches the built browser.
 *
 * @param index - From {@link readInstallIndex}
 * @param engineDir - The engine
 * @param path - Engine-relative path
 */
export async function deliveryOf(
  index: InstallIndex,
  engineDir: string,
  path: string
): Promise<Delivery> {
  const installs = [...(index.files.get(path) ?? [])];
  for (const pattern of index.patterns) {
    if (!path.startsWith(`${pattern.base}/`)) continue;
    const rest = path.slice(pattern.base.length + 1);
    if (!pattern.pattern.test(rest)) continue;
    installs.push({
      symlink: pattern.symlink,
      destination: pattern.destination === undefined ? undefined : join(pattern.destination, rest),
      atTest: pattern.atTest,
    });
  }
  if (installs.length === 0) return 'unlisted';
  if (installs.every((install) => install.atTest)) return 'at-test';
  const source = join(engineDir, path);
  for (const install of installs) {
    if (install.atTest) continue;
    if (!install.symlink || !(await linksTo(install.destination, source))) return 'packaged';
  }
  return 'live';
}
