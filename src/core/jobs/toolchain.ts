// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { arch, homedir, platform, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { getNodeErrorCode } from '../../utils/errors.js';
import { ONNX_RUNTIME_DIR_VARIABLE } from '../mach-mozconfig.js';
import { NATIVE_KEYS, parseConfiguredTool, toolchainManifestPath } from './native-tools.js';
import { cloneTree, pathPresent, removeTree } from './slot-template.js';
import type { NativeToolchainManifest } from './slot-types.js';
import { readJson, writeDurable } from './store.js';
import { toolTreeDigest, treeStatSignature, walkTree, withinRoots } from './tool-files.js';

const runFile = promisify(execFile);

/**
 * What configure selected that is a place rather than a command. Each is held
 * against the manifest once a slot configures. `variable` is how a job hands
 * configure the frozen copy: the name configure reads, or, for an option with no
 * environment name, a name the generated mozconfig turns into the option. The
 * clang entries have neither, because configure derives them from the compiler.
 */
const CONFIGURED_PLACES: Readonly<Record<string, { variable?: string; parent?: boolean }>> = {
  WASI_SYSROOT: { variable: 'WASI_SYSROOT' },
  MACOS_SDK_DIR: { variable: 'MACOS_SDK_DIR' },
  ONNX_RUNTIME: { variable: ONNX_RUNTIME_DIR_VARIABLE, parent: true },
  MOZ_LIBCLANG_PATH: {},
  MOZ_CLANG_PATH: {},
};

/**
 * Paths the operating system or Xcode owns: used where they are, not copied. The
 * directories themselves count too: a Linux distribution's Python has `/usr` as
 * its prefix.
 */
const SYSTEM_PREFIXES = ['/usr/', '/bin/', '/sbin/', '/System/', '/Library/Developer/'];
const isSystemPath = (path: string): boolean =>
  SYSTEM_PREFIXES.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix) ||
  /^\/Applications\/Xcode[^/]*\.app\//.test(path);

/** The directory a tool lives in as a unit, so its libraries and siblings come with it. */
function toolRootOf(path: string): string {
  if (isSystemPath(path)) return path;
  const anchored = /^(.*\/(?:\.mozbuild|\.rustup\/toolchains)\/[^/]+)/.exec(path);
  if (anchored?.[1] !== undefined) return anchored[1];
  const bin = path.lastIndexOf('/bin/');
  return bin > 0 ? path.slice(0, bin) : dirname(path);
}

/** The newest object directory that finished configure, which is what holds the real tools. */
async function configuredObjdir(engine: string): Promise<string> {
  const candidates: Array<{ path: string; at: number }> = [];
  for (const entry of await readdir(engine, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('obj-')) continue;
    const path = join(engine, entry.name);
    const status = await lstat(join(path, 'config.status')).catch(() => undefined);
    if (status !== undefined) candidates.push({ path, at: status.mtimeMs });
  }
  const newest = candidates.sort((a, b) => b.at - a.at)[0];
  if (newest === undefined)
    throw new Error(
      `${engine} has no configured object directory to read tools from; run its build once, or name another engine`
    );
  return newest.path;
}

interface ToolPlan {
  /** Every root, by path, and the name it has inside a generation; in-place roots keep their path. */
  roots: Map<string, string>;
  executables: Record<string, string>;
  environment: Record<string, string>;
  /** What the engine's configure selected, by the name its output gives it. */
  configured: Record<string, string>;
  python: { executable: string; roots: string[] };
}

interface PythonProbe {
  base_prefix: string;
  paths: string[];
}

async function probePython(executable: string): Promise<PythonProbe> {
  const { stdout } = await runFile(
    executable,
    [
      '-I',
      '-B',
      '-c',
      'import json,sys; print(json.dumps({"base_prefix":sys.base_prefix,"paths":sys.path}))',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    }
  );
  return JSON.parse(stdout) as PythonProbe;
}

/** The interpreter inside a prefix: a virtualenv's python points at this one. */
async function interpreterIn(prefix: string, fallback: string): Promise<string> {
  for (const name of ['python3', 'python']) {
    const candidate = join(prefix, 'bin', name);
    if (await pathPresent(candidate)) return candidate;
  }
  return fallback;
}

/**
 * Finds Python's real prefix, and whether a clone of it would still resolve its
 * library from its own location. Most non-relocatable builds hardcode their
 * prefix, so they are used where they are, and their signature catches an upgrade.
 * `home` is the root that holds the interpreter: the prefix, or for an operating
 * system's Python, whose prefix is a shared directory such as `/usr`, only the
 * interpreter itself. Its library is covered by `paths`, so neither a probe clone
 * nor the toolchain's identity ever spans everything else installed there.
 */
async function planPython(
  requested: string,
  store: string
): Promise<{ executable: string; home: string; paths: string[]; relocatable: boolean }> {
  const first = await probePython(requested);
  const prefix = await realpath(first.base_prefix);
  const executable = await interpreterIn(prefix, requested);
  const observed = await probePython(executable);
  const paths: string[] = [];
  for (const path of observed.paths) paths.push(await realpath(path).catch(() => ''));
  if (isSystemPath(prefix))
    return {
      executable,
      home: await realpath(executable),
      paths: paths.filter(Boolean),
      relocatable: false,
    };
  const probeDirectory = join(store, `.probe-${randomUUID()}`);
  let relocatable: boolean;
  await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
  try {
    await cloneTree(prefix, join(probeDirectory, 'python'));
    const clone = await realpath(join(probeDirectory, 'python'));
    const moved = await probePython(join(clone, relative(prefix, await realpath(executable))));
    const resolved = await Promise.all(moved.paths.map((path) => realpath(path).catch(() => '')));
    relocatable = resolved.every((path) => path === '' || withinRoots(path, [clone]));
  } catch {
    relocatable = false;
  } finally {
    await removeTree(probeDirectory);
  }
  return { executable, home: prefix, paths: paths.filter(Boolean), relocatable };
}

/**
 * Reads what an engine's configure actually selected: commands, their SDK and
 * sysroot arguments, and Python. Nothing here runs a compiler.
 */
async function planToolchain(
  engine: string,
  store: string,
  pythonOverride: string | undefined
): Promise<ToolPlan> {
  const substs = join(await configuredObjdir(engine), 'config.statusd', 'substs');
  const read = async (key: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(join(substs, key), 'utf8')) as unknown;
    } catch (error) {
      if (getNodeErrorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  };
  const roots = new Map<string, string>();
  const nameFor = (root: string): string => {
    if (isSystemPath(root)) return root;
    const taken = new Set(roots.values());
    const base = basename(root);
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}`;
    return name;
  };
  const addRoot = (path: string): string => {
    const root = toolRootOf(path);
    if (!roots.has(root)) roots.set(root, nameFor(root));
    return root;
  };
  const rustc = parseConfiguredTool(await read('RUSTC')).command;
  const executables: Record<string, string> = {};
  for (const key of NATIVE_KEYS) {
    const value = await read(key);
    if (value === undefined) continue;
    const { command, paths } = parseConfiguredTool(value);
    if (command === undefined || !isAbsolute(command)) continue;
    // A rustup proxy finds its toolchain from the user's state, so a frozen one has to name the real binary.
    const real =
      rustc !== undefined && command.includes('/.cargo/bin/')
        ? join(dirname(rustc), basename(command))
        : command;
    executables[key] = real;
    addRoot(real);
    for (const path of paths) if (path !== command && (await pathPresent(path))) addRoot(path);
  }
  for (const key of ['CC', 'CXX', 'RUSTC', 'CARGO'])
    if (executables[key] === undefined)
      throw new Error(`${substs} names no ${key}; run configure in that engine first`);
  const environment: Record<string, string> = {};
  const configured: Record<string, string> = {};
  for (const [key, { variable, parent }] of Object.entries(CONFIGURED_PLACES)) {
    const value = await read(key);
    if (typeof value !== 'string' || !isAbsolute(value) || !(await pathPresent(value))) continue;
    configured[key] = value;
    addRoot(value);
    if (variable !== undefined) environment[variable] = parent === true ? dirname(value) : value;
  }
  const declared = parseConfiguredTool(await read('PYTHON3')).command;
  const requested = pythonOverride ?? declared ?? 'python3';
  const python = await planPython(requested, store);
  const pythonRoots = [python.home];
  roots.set(python.home, python.relocatable ? nameFor('python') : python.home);
  if (!python.relocatable)
    for (const path of python.paths)
      if (!withinRoots(path, [...roots.keys()])) {
        roots.set(path, path);
        pythonRoots.push(path);
      }
  return {
    roots,
    executables,
    environment,
    configured,
    python: { executable: python.executable, roots: pythonRoots },
  };
}

/** Where every host's frozen tool generations live. */
function toolchainStore(): string {
  return resolve(
    process.env['FIREFORGE_TOOLCHAINS'] ?? join(userInfo().homedir, '.fireforge', 'toolchains')
  );
}

/** Refuses a root that would sweep up the home directory or credentials. */
function assertSafeRoot(root: string): void {
  if (['/', homedir()].includes(resolve(root)))
    throw new Error(`A tool root cannot be ${root}; configure the tool from its own directory`);
  if (root.split(sep).some((part) => ['.ssh', '.aws', '.gnupg'].includes(part)))
    throw new Error(`A tool root cannot hold credentials: ${root}`);
}

/** Absolute links inside a generation still name where they were cloned from. */
async function repointLinks(
  clone: string,
  sourceRoots: ReadonlyMap<string, string>,
  generation: string
): Promise<void> {
  await walkTree(clone, async ({ path, info }) => {
    if (!info.isSymbolicLink()) return;
    const target = await readlink(path);
    if (!isAbsolute(target)) return;
    for (const [source, name] of sourceRoots)
      if (name !== source && withinRoots(target, [source])) {
        await rm(path);
        await symlink(join(generation, name, relative(source, target)), path);
        return;
      }
  });
}

/** Maps a tool path from where configure found it to where this generation holds it. */
function relocate(path: string, roots: ReadonlyMap<string, string>, generation: string): string {
  for (const [root, name] of roots)
    if (name !== root && withinRoots(path, [root]))
      return join(generation, name, relative(root, path));
  return path;
}

/** Whichever root a path lies in, as a name and a relative path, so the digest holds no location. */
function portable(path: string, roots: ReadonlyMap<string, string>): [string, string] {
  for (const [root, name] of roots)
    if (withinRoots(path, [root])) return [name, relative(root, path)];
  return [path, ''];
}

/**
 * Derives this host's toolchain from an engine's configure output: clones the
 * tools read-only under a directory named for their bytes, reusing one that
 * exists, and records the manifest in the namespace. Captured source never holds
 * a host path.
 */
export async function deriveToolchain(options: {
  namespace: string;
  engine: string;
  python?: string;
  sites?: string[];
}): Promise<{ manifest: NativeToolchainManifest; reused: boolean }> {
  const store = toolchainStore();
  await mkdir(store, { recursive: true, mode: 0o700 });
  const plan = await planToolchain(resolve(options.engine), store, options.python);
  for (const root of plan.roots.keys()) assertSafeRoot(root);
  const canonical = await Promise.all([...plan.roots.keys()].map((root) => realpath(root)));
  const named: Array<{ name: string; tree: string }> = [];
  const sourceDigests = new Map<string, string>();
  for (const [root, name] of plan.roots) {
    const tree = await toolTreeDigest(root, { aliases: canonical, externalLinks: name === root });
    sourceDigests.set(root, tree);
    named.push({ name, tree });
  }
  const portableExecutables = Object.fromEntries(
    Object.entries(plan.executables).map(([key, path]) => [key, portable(path, plan.roots)])
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 3,
        platform: platform(),
        arch: arch(),
        roots: named.sort((a, b) => a.name.localeCompare(b.name)),
        executables: portableExecutables,
        environment: Object.fromEntries(
          Object.entries(plan.environment).map(([key, path]) => [key, portable(path, plan.roots)])
        ),
        configured: Object.fromEntries(
          Object.entries(plan.configured).map(([key, path]) => [key, portable(path, plan.roots)])
        ),
        python: portable(plan.python.executable, plan.roots),
        sites: options.sites ?? null,
      })
    )
    .digest('hex');
  const generation = join(store, digest);
  const sealed = `${generation}.json`;
  let manifest = await readJson<NativeToolchainManifest>(sealed).catch(() => undefined);
  const reused = manifest !== undefined && (await pathPresent(generation));
  if (!reused) {
    await removeTree(generation);
    const building = `${generation}.building-${randomUUID()}`;
    await mkdir(building, { mode: 0o700 });
    for (const [root, name] of plan.roots)
      if (name !== root) {
        await cloneTree(root, join(building, name));
        await repointLinks(join(building, name), plan.roots, generation);
      }
    await runFile('chmod', ['-R', 'a-w', building]);
    await rename(building, generation);
    const final = (path: string): string => relocate(path, plan.roots, generation);
    const pythonRoots = plan.python.roots.map(final);
    const nativeRoots = [...plan.roots.keys()].map(final);
    const rootDigests = Object.fromEntries(
      [...plan.roots.keys()].map((root) => [final(root), sourceDigests.get(root) ?? ''])
    );
    manifest = {
      schemaVersion: 3,
      platform: platform(),
      arch: arch(),
      digest,
      signature: await treeStatSignature([...new Set([...pythonRoots, ...nativeRoots])]),
      rootDigests,
      python: {
        executable: final(plan.python.executable),
        roots: pythonRoots,
        ...(options.sites === undefined ? {} : { sites: options.sites }),
      },
      native: {
        executables: Object.fromEntries(
          Object.entries(plan.executables).map(([key, path]) => [key, final(path)])
        ),
        roots: nativeRoots,
        environment: Object.fromEntries(
          Object.entries(plan.environment).map(([key, path]) => [key, final(path)])
        ),
        configured: Object.fromEntries(
          Object.entries(plan.configured).map(([key, path]) => [key, final(path)])
        ),
      },
    };
    await writeDurable(sealed, manifest);
  }
  if (manifest === undefined) throw new Error('Toolchain generation has no manifest');
  await writeDurable(toolchainManifestPath(options.namespace), manifest);
  return { manifest, reused };
}
