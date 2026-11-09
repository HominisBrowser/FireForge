// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { getNodeErrorCode } from '../../utils/errors.js';
import { getPlatform } from '../../utils/platform.js';
import { readSourceBlobs } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { nativeRecipeDigest, nativeSites, verifyQualifiedSites } from './native-state.js';
import type { JobStep } from './schema.js';
import type { NativeToolchainManifest } from './slot-types.js';
import { stepTraits } from './step-traits.js';
import { readJson } from './store.js';
import { forgetFileDigests, toolTreeDigest, treeStatSignature, withinRoots } from './tool-files.js';

const runFile = promisify(execFile);

/** Configure's tool exports the toolchain supplies and a configured objdir has to agree with. */
export const NATIVE_KEYS: readonly string[] = [
  'CC',
  'CXX',
  'RUSTC',
  'CARGO',
  'RUSTDOC',
  'RUSTFMT',
  'HOST_CC',
  'HOST_CXX',
  'AR',
  'HOST_AR',
  'AS',
  'LD',
  'STRIP',
  'RANLIB',
  'OBJCOPY',
  'DSYMUTIL',
  'LLVM_OBJDUMP',
  'LLVM_PROFDATA',
  'OTOOL',
  'NODEJS',
  'CBINDGEN',
  'DUMP_SYMS',
  'WASM_CC',
  'WASM_CXX',
];

/** Where the host's toolchain manifest lives: outside any captured source, so paths stay local. */
export const toolchainManifestPath = (namespace: string): string =>
  join(namespace, 'toolchain.json');

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((entry) => typeof entry === 'string');

/** Whether a stored manifest is one this version wrote, for this platform. */
function isToolchainManifest(value: unknown): value is NativeToolchainManifest {
  if (!isObject(value)) return false;
  const { python, native } = value;
  return (
    value['schemaVersion'] === 3 &&
    value['platform'] === platform() &&
    value['arch'] === arch() &&
    typeof value['digest'] === 'string' &&
    typeof value['signature'] === 'string' &&
    isStringMap(value['rootDigests']) &&
    isObject(python) &&
    typeof python['executable'] === 'string' &&
    isStringList(python['roots']) &&
    isObject(native) &&
    isStringMap(native['executables']) &&
    isStringMap(native['configured']) &&
    isStringList(native['roots'])
  );
}

/** Native execution needs this host's derived tools; ambient ones never qualify. */
export async function readHostToolchain(namespace: string): Promise<NativeToolchainManifest> {
  let value: unknown;
  try {
    value = await readJson<unknown>(toolchainManifestPath(namespace));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT')
      throw new Error(
        'This host has no qualified toolchain; derive one with: fireforge host init --from-engine <engine>',
        { cause: error }
      );
    throw error;
  }
  if (!isToolchainManifest(value))
    throw new Error(
      'Unsupported toolchain manifest for this host; derive it again with: fireforge host init --from-engine <engine>'
    );
  return value;
}

/** Every root a toolchain's identity covers. */
export function toolchainRoots(manifest: NativeToolchainManifest): string[] {
  return [...new Set([...manifest.python.roots, ...manifest.native.roots])];
}

/**
 * Confirms a toolchain is the one recorded. A job compares the stat signature;
 * a final gate, or a signature that moved, reads every byte.
 *
 * @throws When the bytes changed
 */
export async function assertToolchainCurrent(
  manifest: NativeToolchainManifest,
  options: { full?: boolean } = {}
): Promise<void> {
  const roots = toolchainRoots(manifest);
  if (options.full === true) forgetFileDigests();
  else if ((await treeStatSignature(roots)) === manifest.signature) return;
  const canonical = await Promise.all(roots.map((root) => realpath(root)));
  const digests = await Promise.all(
    canonical.map((root) => toolTreeDigest(root, { aliases: canonical, externalLinks: true }))
  );
  const expected = manifest.rootDigests;
  roots.forEach((root, index) => {
    if (expected[root] !== digests[index])
      throw new Error(
        `Native tool bytes changed under ${root}; derive the toolchain again with: fireforge host init --from-engine <engine>`
      );
  });
}

/** A check's project commands that are not declared static: they may do anything, native included. */
export function nonStaticCheckSteps(snapshot: AuthoredSnapshot): string[] {
  return (snapshot.config.check?.extraSteps ?? [])
    .filter((step) => step.footprint?.static !== true)
    .map((step) => step.name);
}

/** Whether a step runs Mach, a browser or a project command that is not declared static. */
export function needsNativeTools(step: JobStep, snapshot?: AuthoredSnapshot): boolean {
  return (
    ['build', 'test', 'run', 'package'].includes(step.command) ||
    (step.command === 'check' && snapshot !== undefined && nonStaticCheckSteps(snapshot).length > 0)
  );
}

/** The command and every absolute path in a configure export, whichever shape it has. */
export function parseConfiguredTool(value: unknown): { command?: string; paths: string[] } {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  const command: unknown = Array.isArray(value)
    ? (value as unknown[])[0]
    : typeof value === 'string'
      ? /^([^\s"'`$;|&]+)/.exec(value)?.[1]
      : undefined;
  const paths = [...text.matchAll(/(?:^|[\s="'])(\/[^\s"'`,]+)(?=$|[\s"',])/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]]
  );
  return { ...(typeof command === 'string' ? { command } : {}), paths };
}

const REDERIVE = 'derive it again with: fireforge host init --from-engine <engine>';

/** A configure export, or undefined when this configure did not set it. */
async function readSubst(objdir: string, key: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(objdir, 'config.statusd', 'substs', key), 'utf8'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Holds one configured object directory against the manifest, so a tool nobody
 * derived is caught where configure runs rather than at seal. A place the deriving
 * engine's configure selected and this one did not is refused too: losing ONNX
 * Runtime leaves a build that passes and a package without it. Reads the JSON
 * exports and runs nothing.
 */
export async function checkConfiguredObjdir(
  objdir: string,
  manifest: NativeToolchainManifest
): Promise<void> {
  const roots = await Promise.all(toolchainRoots(manifest).map((root) => realpath(root)));
  const covered = async (path: string, label: string): Promise<string> => {
    const canonical = await realpath(path);
    if (!withinRoots(canonical, roots))
      throw new Error(
        `Configured ${label} is not in this host's toolchain: ${canonical}; ${REDERIVE}`
      );
    return canonical;
  };
  for (const key of NATIVE_KEYS) {
    const value = await readSubst(objdir, key);
    if (value === undefined) {
      if (['CC', 'CXX', 'RUSTC', 'CARGO'].includes(key))
        throw new Error(
          `Unsupported configured tool discovery: missing config.statusd/substs/${key}`
        );
      continue;
    }
    const { command, paths } = parseConfiguredTool(value);
    if (command === undefined || !isAbsolute(command))
      throw new Error(
        `Unsupported configured ${key}: use an absolute compiler command with a supported JSON export`
      );
    const expected = manifest.native.executables[key];
    if (expected === undefined)
      throw new Error(
        `Configured ${key} (${command}) is missing from this host's toolchain; ${REDERIVE}`
      );
    if ((await realpath(expected)) !== (await covered(command, key)))
      throw new Error(`Configured ${key} differs from this host's toolchain: ${command}`);
    for (const path of paths) await covered(path, `${key} argument`);
  }
  for (const [key, expected] of Object.entries(manifest.native.configured)) {
    const value = await readSubst(objdir, key);
    if (typeof value !== 'string' || value === '')
      throw new Error(
        `This configure did not select ${key}, which the engine this toolchain came from did (${expected}). The build would leave it out; check the mozconfig or ${REDERIVE}`
      );
    if ((await covered(value, key)) !== (await realpath(expected)))
      throw new Error(`Configured ${key} differs from this host's toolchain: ${value}`);
  }
}

/** Every object directory in an engine that finished configure, held against the manifest. */
export async function checkConfiguredTools(
  engine: string,
  manifest: NativeToolchainManifest
): Promise<void> {
  for (const entry of await readdir(engine, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('obj-')) continue;
    const obj = join(engine, entry.name);
    try {
      await access(join(obj, 'config.status'));
    } catch (error) {
      if (getNodeErrorCode(error) === 'ENOENT') continue;
      throw error;
    }
    await checkConfiguredObjdir(obj, manifest);
  }
}

/** The mozconfig inputs a slot's build reads, by path. */
const mozconfigPaths = (): string[] => [
  'configs/common.mozconfig',
  `configs/${getPlatform()}.mozconfig`,
];

/**
 * What would have to change for native configure to use the frozen tools rather
 * than fetch its own into mutable state, as one edit per line. Empty when
 * nothing has to.
 */
export function bootstrapChanges(
  configs: ReadonlyMap<string, string>
): Array<{ path: string; line?: number; change: string }> {
  const changes: Array<{ path: string; line?: number; change: string }> = [];
  let disabled = false;
  for (const [path, text] of configs)
    for (const [index, raw] of text.split('\n').entries()) {
      const line = raw.split('#')[0] ?? '';
      if (/^\s*ac_add_options\s+--disable-bootstrap\s*$/.test(line)) disabled = true;
      if (/--enable-bootstrap(?:[=\s]|$)/.test(line)) {
        disabled = true;
        changes.push({
          path,
          line: index + 1,
          change: `replace "${raw.trim()}" with "ac_add_options --disable-bootstrap"`,
        });
      }
    }
  if (!disabled)
    changes.push({
      path: mozconfigPaths()[0] ?? 'configs/common.mozconfig',
      change: 'add the line "ac_add_options --disable-bootstrap"',
    });
  return changes;
}

/**
 * Native configure must use the frozen tools.
 *
 * @throws With the exact edit, naming each line, when a captured config lets it fetch its own
 */
export async function assertNativeBootstrapDisabled(snapshot: AuthoredSnapshot): Promise<void> {
  const inputs = snapshot.inputs.filter((input) => mozconfigPaths().includes(input.path));
  const blobs = await readSourceBlobs(
    snapshot.repository,
    inputs.map((input) => input.blob)
  );
  const changes = bootstrapChanges(
    new Map(inputs.map((input) => [input.path, blobs.get(input.blob)?.toString('utf8') ?? '']))
  );
  if (changes.length > 0)
    throw new Error(
      `Qualified native builds use frozen tools, so automatic bootstrap has to be off. Change: ${changes
        .map(
          (item) => `${item.path}${item.line === undefined ? '' : `:${item.line}`}: ${item.change}`
        )
        .join('; ')}`
    );
}

/** The interpreter resolves inside its declared roots; run at qualification and a final gate. */
export async function assertPythonResolution(manifest: NativeToolchainManifest): Promise<void> {
  const roots = await Promise.all(manifest.python.roots.map((root) => realpath(root)));
  const python = await realpath(manifest.python.executable);
  if (!withinRoots(python, roots))
    throw new Error(`Uncovered Python executable: ${python}; re-derive the toolchain`);
  for (const entry of (process.env['PYTHONPATH'] ?? '').split(delimiter).filter(Boolean))
    if (!withinRoots(await realpath(entry), roots))
      throw new Error(`Uncovered PYTHONPATH entry: ${entry}`);
  const probe = await runFile(
    python,
    [
      '-I',
      '-B',
      '-c',
      'import json,sys,sysconfig; print(json.dumps({"executable":sys.executable,"paths":sys.path,"stdlib":sysconfig.get_path("stdlib"),"purelib":sysconfig.get_path("purelib"),"platlib":sysconfig.get_path("platlib")}))',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      maxBuffer: 1024 * 1024,
    }
  );
  const observed: unknown = JSON.parse(probe.stdout);
  if (
    !isObject(observed) ||
    !Array.isArray(observed['paths']) ||
    typeof observed['executable'] !== 'string'
  )
    throw new Error('Python runtime identity probe failed');
  if ((await realpath(observed['executable'])) !== python)
    throw new Error('Resolved Python executable differs from the toolchain manifest');
  for (const item of [
    ...(observed['paths'] as unknown[]),
    observed['stdlib'],
    observed['purelib'],
    observed['platlib'],
  ]) {
    if (typeof item !== 'string' || item === '') continue;
    try {
      if (!withinRoots(await realpath(item), roots))
        throw new Error(`Uncovered Python stdlib/site-packages: ${item}; re-derive the toolchain`);
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
  }
}

/** Controlled native environment: tool paths come from the host manifest, never a caller's claims. */
export function nativeToolEnvironment(
  manifest: NativeToolchainManifest,
  projectRoot: string,
  qualifiedGit?: string
): Record<string, string> {
  return {
    PATH: [
      ...new Set([
        ...(qualifiedGit === undefined ? [] : [dirname(qualifiedGit)]),
        dirname(manifest.python.executable),
        ...Object.values(manifest.native.executables).map((file) => dirname(file)),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]),
    ].join(delimiter),
    MOZBUILD_STATE_PATH: join(projectRoot, '.fireforge', 'native-state'),
    MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE: 'pip',
    MACH_NO_UV: '1',
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PIP_CACHE_DIR: join(projectRoot, '.fireforge', 'native-state', 'pip-cache'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    MACHRC: join(projectRoot, '.fireforge', 'native-state', 'empty-machrc'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ...Object.fromEntries(
      Object.entries(manifest.native.executables).filter(
        ([key, file]) => NATIVE_KEYS.includes(key) && !derivedFromCompiler(manifest, key, file)
      )
    ),
    ...manifest.native.environment,
  };
}

/**
 * Configure defaults the assembler to the C compiler with its target and SDK
 * flags. Exported bare, `AS` would replace that and lose them, so an assembler
 * that is the C compiler is left for configure to derive from the exported `CC`.
 */
function derivedFromCompiler(
  manifest: NativeToolchainManifest,
  key: string,
  file: string
): boolean {
  return key === 'AS' && file === manifest.native.executables['CC'];
}

/**
 * What the compiled anchor binds: the toolchain's bytes, the Mach recipe and the
 * site roster. Portable by construction, since it holds no path and no
 * per-job value, so two slots on one host agree and a requalification with
 * unchanged tools changes nothing.
 */
export function nativeBuildDigest(
  manifest: NativeToolchainManifest,
  snapshot: AuthoredSnapshot
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        toolchain: manifest.digest,
        recipe: nativeRecipeDigest(snapshot),
        sites: nativeSites(manifest),
      })
    )
    .digest('hex');
}

/**
 * Confirms a slot may run native work and names the tools it will use. A job
 * compares stat signatures, a final gate reads the bytes, and a configured
 * objdir has to agree whenever one is about to be used or sealed.
 */
export async function nativeToolIdentity(options: {
  namespace: string;
  snapshot: AuthoredSnapshot;
  projectRoot: string;
  steps: readonly JobStep[];
  strictConfigured?: boolean;
  full?: boolean;
}): Promise<string> {
  const { namespace, snapshot, projectRoot, steps, strictConfigured, full } = options;
  const manifest = await readHostToolchain(namespace);
  if (steps.some((step) => stepTraits(step).native)) await assertNativeBootstrapDisabled(snapshot);
  await assertToolchainCurrent(manifest, { full: full === true });
  if (full === true) await assertPythonResolution(manifest);
  await verifyQualifiedSites(snapshot, manifest, projectRoot, { full: full === true });
  if (strictConfigured === true || !steps.some((step) => stepTraits(step).builds))
    await checkConfiguredTools(join(projectRoot, 'engine'), manifest);
  return nativeBuildDigest(manifest, snapshot);
}
