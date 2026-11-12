// SPDX-License-Identifier: EUPL-1.2
/**
 * The project every command starts from: where it is, its validated
 * configuration, its mode, and every well-known location named once.
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  CONFIG_FILE,
  type FireForgeConfig,
  loadConfig,
  type SourceConfig,
} from '../config/index.js';
import { defined, ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { type Checkout, readCheckout } from './checkout.js';

/** Locations inside the project directory that both modes have. */
export interface ProjectPaths {
  /** The project directory. */
  readonly root: string;
  /** `fireforge.json`. */
  readonly config: string;
  /** `furnace.json`, the component configuration (it need not exist). */
  readonly furnace: string;
  /** `.fireforge/`: project state, never committed. */
  readonly stateDir: string;
  /** `.fireforge/state.json`, read through `readState`. */
  readonly state: string;
  /** `patches/`: the patch queue, or a source-mode export's default output. */
  readonly patches: string;
  /** `components/`: Furnace component sources. */
  readonly components: string;
  /** `configs/`: mozconfig fragments. */
  readonly configs: string;
}

/** Locations of a patch-mode project. */
export interface PatchPaths extends ProjectPaths {
  /** `engine/`: the Firefox checkout edited in place, the project's one workspace. */
  readonly engine: string;
}

/** Locations of a source-mode project. */
export interface SourcePaths extends ProjectPaths {
  /** `source.root`: `<source>/<path>` supplies engine file `<path>`. */
  readonly source: string;
  /** `source.metadataRoot`: the upstream identity of every overridden upstream file. */
  readonly sourceMetadata: string;
}

/** Per-host state shared by every project and checkout of one user. */
export interface HostPaths {
  /** `~/.fireforge`, or `FIREFORGE_HOME`. */
  readonly root: string;
  /** Pristine repositories, one per pin. */
  readonly pristine: string;
  /** The workspace pool. */
  readonly workspaces: string;
  /** Host locks (display, build). */
  readonly locks: string;
  /** Downloaded archives. */
  readonly cache: string;
}

interface ProjectBase {
  readonly root: string;
  readonly host: HostPaths;
  readonly checkout: Checkout;
}

/** A patch-mode project. */
export interface PatchProject extends ProjectBase {
  readonly mode: 'patches';
  readonly config: FireForgeConfig;
  readonly paths: PatchPaths;
}

/** A source-mode project. Its configuration always carries the `source` block. */
export interface SourceProject extends ProjectBase {
  readonly mode: 'source';
  readonly config: FireForgeConfig & { readonly mode: 'source'; readonly source: SourceConfig };
  readonly paths: SourcePaths;
}

/** A loaded project. Only the `mode` module branches on which kind it is. */
export type Project = PatchProject | SourceProject;

/** Environment variables FireForge reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The locations both modes share, for a project directory.
 *
 * @param root - The project directory
 */
export function projectPaths(root: string): ProjectPaths {
  const stateDir = join(root, '.fireforge');
  return {
    root,
    config: join(root, CONFIG_FILE),
    furnace: join(root, 'furnace.json'),
    stateDir,
    state: join(stateDir, 'state.json'),
    patches: join(root, 'patches'),
    components: join(root, 'components'),
    configs: join(root, 'configs'),
  };
}

/**
 * The per-host state locations: `FIREFORGE_HOME` when set, else `~/.fireforge`.
 *
 * @param env - The environment to read `FIREFORGE_HOME` from
 * @throws `fireforge-home-invalid` (exit code 2) when it is set to a relative path
 */
export function hostPaths(env: Environment = process.env): HostPaths {
  const configured = env['FIREFORGE_HOME'];
  if (configured !== undefined && configured !== '' && !isAbsolute(configured)) {
    throw new FireForgeError(
      'fireforge-home-invalid',
      `FIREFORGE_HOME must be an absolute path (got "${configured}")`,
      { exitCode: ExitCode.CONFIG_ERROR, hint: 'Set it to an absolute directory, or unset it.' }
    );
  }
  const root =
    configured === undefined || configured === '' ? join(homedir(), '.fireforge') : configured;
  return {
    root,
    pristine: join(root, 'pristine'),
    workspaces: join(root, 'workspaces'),
    locks: join(root, 'locks'),
    cache: join(root, 'cache'),
  };
}

/**
 * The project directory: `cwd` or the nearest directory above it holding
 * `fireforge.json`.
 *
 * @param cwd - Where the command was run
 * @throws `project-not-found` (exit code 2) when no directory up to the file-system root has one
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (await exists(join(current, CONFIG_FILE))) return current;
    if (dirname(current) === current) break;
  }
  throw new FireForgeError(
    'project-not-found',
    `No ${CONFIG_FILE} in ${resolve(cwd)} or any directory above it`,
    {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Run the command inside a project, or create one with "fireforge setup".',
    }
  );
}

/**
 * Finds and loads the project containing `cwd`: its validated configuration,
 * its locations, the host locations and the git checkout it sits in.
 *
 * @param cwd - Where the command was run
 * @param env - The environment of the invocation
 * @throws `project-not-found`, `config-missing` or `config-invalid` (exit code 2)
 */
export async function loadProject(cwd: string, env: Environment = process.env): Promise<Project> {
  const root = await findProjectRoot(cwd);
  const config = await loadConfig(root);
  const base = { root, host: hostPaths(env), checkout: await readCheckout(root) };
  const paths = projectPaths(root);
  if (config.mode === 'patches') {
    return { ...base, mode: 'patches', config, paths: { ...paths, engine: join(root, 'engine') } };
  }
  const source = defined(config.source, 'the schema requires a source block in source mode');
  return {
    ...base,
    mode: 'source',
    config: { ...config, mode: 'source', source },
    paths: {
      ...paths,
      source: join(root, source.root),
      sourceMetadata: join(root, source.metadataRoot),
    },
  };
}

/** A path as the configuration writes it, resolved to the tree it names. */
export interface ConfiguredPath {
  /** `engine`: an engine file; `project`: a file of the project directory. */
  readonly tree: 'engine' | 'project';
  /** Relative to that tree's root; empty for the root itself. */
  readonly path: string;
}

/**
 * Which file a path written in the configuration names: `engine/<path>` is
 * engine file `<path>`, wherever the engine is; anything else is relative to
 * the project directory.
 *
 * @param path - A relative path as configured
 */
export function configuredPath(path: string): ConfiguredPath {
  const normalized = path.replace(/^(?:\.\/)+/, '');
  if (normalized === 'engine') return { tree: 'engine', path: '' };
  return normalized.startsWith('engine/')
    ? { tree: 'engine', path: normalized.slice('engine/'.length) }
    : { tree: 'project', path: normalized };
}
