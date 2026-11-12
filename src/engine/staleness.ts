// SPDX-License-Identifier: EUPL-1.2
/**
 * Whether a workspace's build still matches its engine. The one answer
 * `test`, `run` and `package` all ask for.
 *
 * A successful build records a baseline in the workspace's state: a snapshot
 * of the engine's working tree as a git tree (kept alive by a ref in the
 * engine's repository), a second one for the last full build, and the digest
 * of the mozconfig. Staleness is the diff from those snapshots to the working
 * tree now, read through what each changed path means to the build:
 *
 *  - compiled sources and build definitions reach the browser only through a
 *    full build, so they are compared with the last full build;
 *  - packaged front-end files are compared with the last build of any kind,
 *    and do not count while the object directory serves them by symlink;
 *  - a `jar.mn` needs a full build only when the build backend has never
 *    seen it, or when it installs outside the default chrome root; an entry
 *    added to a known manifest is installed by a UI build;
 *  - anything else (tests, documentation) never makes a build stale.
 */
import { join } from 'node:path';

import {
  captureWorktree,
  changedPaths,
  commitTree,
  readBlobs,
  resolveRevision,
  updateRef,
} from '../git/index.js';
import { exists, readTextIfExists } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { type Infer, s } from '../kernel/schema.js';
import { defineStateSection, readState, updateState } from '../project/index.js';
import { deliveryOf, readInstallIndex } from './installManifests.js';
import { renderMozconfig } from './mozconfig.js';
import { findBrowserBinary, movedFrom } from './objdir.js';
import type { Workspace } from './workspace.js';

/** Which `mach build` ran: everything, or the front end only (`mach build faster`). */
export type BuildKind = 'full' | 'ui';

const baselineSection = defineStateSection(
  'build',
  s.object({
    kind: s.enum(['full', 'ui']),
    builtAt: s.string(),
    /** Commit wrapping the engine's working tree as the last build saw it. */
    tree: s.string({ min: 1 }),
    /** The same for the last full build. */
    fullTree: s.string({ min: 1 }),
    /** SHA-256 of the mozconfig the object directory was configured with. */
    mozconfig: s.string({ min: 1 }),
  }),
  'fireforge build'
);

/** What a workspace records about its last successful build. */
export type BuildBaseline = Infer<typeof baselineSection.schema>;

/** The answer of {@link buildStaleness}. */
export type BuildStaleness =
  | { state: 'fresh' }
  | {
      state: 'stale';
      /** Engine-relative paths that changed since the build that would have consumed them. */
      paths: string[];
      /** The smallest build that makes the workspace fresh. */
      needs: BuildKind;
      /** One sentence saying why, for a message. */
      why: string;
    };

const COMPILED_EXTENSIONS = new Set(
  'c cc cpp cxx h hh hpp m mm rs idl webidl ipdl ipdlh yaml yml s S asm inc tbl def'.split(' ')
);
const COMPILED_NAMES = new Set(['Bindings.conf', 'Cargo.toml', 'Cargo.lock', 'components.conf']);
/** Files the build backend is generated from. */
const BACKEND_NAMES = new Set(['moz.build', 'moz.configure', 'Makefile.in', 'mozbuild.in']);
const BACKEND_EXTENSIONS = new Set(['mozbuild', 'configure']);
/** Directories whose compiled sources never reach the browser binary. */
const NON_RUNTIME_SEGMENTS = new Set(['test', 'tests', 'gtest', 'testing', 'taskcluster']);
const PACKAGED_EXTENSIONS = new Set('js mjs jsm css ftl xhtml xul html properties'.split(' '));
const PACKAGED_FRAGMENTS = ['/app/profile/', '/chrome/', '/locales/'];

/** How a changed engine path bears on the build. */
export type BuildInputClass =
  /** Reaches the browser only through a full build. */
  | 'full'
  /** A chrome packaging manifest. */
  | 'jar'
  /** A front-end file a UI build installs. */
  | 'ui';

/**
 * Whether a path belongs to the test tree rather than the browser: a test
 * directory, the harness tree, or a file named like a test.
 *
 * @param path - Engine-relative path
 */
export function isTestPath(path: string): boolean {
  if (/(?:^|\/)(?:test|tests|testing)\//.test(path)) return true;
  return /^(?:browser|test)_.+\.(?:js|toml|ini)$/.test(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * How a changed engine path bears on the build, by its name alone.
 *
 * @param path - Engine-relative path
 * @returns Undefined for a path no build consumes
 */
export function buildInputClass(path: string): BuildInputClass | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (name === 'jar.mn') return 'jar';
  if (BACKEND_NAMES.has(name) || BACKEND_EXTENSIONS.has(extension)) return 'full';
  if (COMPILED_EXTENSIONS.has(extension) || COMPILED_NAMES.has(name)) {
    return path.split('/').some((segment) => NON_RUNTIME_SEGMENTS.has(segment))
      ? undefined
      : 'full';
  }
  if (
    PACKAGED_EXTENSIONS.has(extension) ||
    PACKAGED_FRAGMENTS.some((part) => path.includes(part))
  ) {
    return 'ui';
  }
  return undefined;
}

/** A jar declaration that installs under another base directory: `[dir] name.jar:` at column zero. */
const REDIRECTED_JAR = /^\[[^\]]*\]\s*[^\s[\]]+\.jar:\s*$/m;

const digest = (text: string): string => hash(text);

/** The engine's working tree and mozconfig as a build is about to read them. */
export interface EngineSnapshot {
  /** Commit wrapping the working tree. */
  readonly tree: string;
  /** SHA-256 of the mozconfig. */
  readonly mozconfig: string;
}

/**
 * Snapshots the engine as a build is about to read it: what a successful
 * build then records, so an edit made while the build ran is not taken as
 * built.
 *
 * @param workspace - The workspace
 */
export async function snapshotEngine(workspace: Workspace): Promise<EngineSnapshot> {
  const { engineDir } = workspace;
  const head = await resolveRevision(engineDir, 'HEAD', 'commit');
  const tree = await commitTree(engineDir, await captureWorktree(engineDir), {
    message: 'fireforge build input',
    parents: head === undefined ? [] : [head],
  });
  const mozconfig = digest((await readTextIfExists(join(engineDir, 'mozconfig'))) ?? '');
  return { tree, mozconfig };
}

/**
 * Records that a build of the workspace succeeded, as the baseline
 * {@link buildStaleness} measures from.
 *
 * @param workspace - The workspace
 * @param kind - Which build ran
 * @param snapshot - The engine as the build started reading it
 * @returns The baseline as recorded
 */
export async function recordBuild(
  workspace: Workspace,
  kind: BuildKind,
  snapshot: EngineSnapshot
): Promise<BuildBaseline> {
  const { engineDir } = workspace;
  const { tree, mozconfig } = snapshot;
  await updateRef(engineDir, 'refs/fireforge/build/last', tree);
  if (kind === 'full') await updateRef(engineDir, 'refs/fireforge/build/full', tree);
  const recorded = await updateState(workspace, baselineSection, (previous) => ({
    kind,
    builtAt: new Date().toISOString(),
    tree,
    // A UI build on top of nothing recorded can only follow a full build made elsewhere.
    fullTree: kind === 'full' ? tree : (previous?.fullTree ?? tree),
    mozconfig,
  }));
  return recorded as BuildBaseline;
}

/**
 * The baseline of a workspace's last successful build.
 *
 * @param workspace - The workspace
 */
export function readBuildBaseline(workspace: Workspace): Promise<BuildBaseline | undefined> {
  return readState(workspace, baselineSection);
}

function stale(needs: BuildKind, why: string, paths: string[] = []): BuildStaleness {
  return { state: 'stale', paths: [...paths].sort(), needs, why };
}

/** The changed `jar.mn` files that a UI build cannot install. */
async function escalatingJars(
  engineDir: string,
  jars: readonly string[],
  fullTree: string
): Promise<string[]> {
  if (jars.length === 0) return [];
  const known = await readBlobs(
    engineDir,
    jars.map((path) => `${fullTree}:${path}`)
  );
  const escalating: string[] = [];
  for (const path of jars) {
    const text = await readTextIfExists(join(engineDir, path));
    // Removed: the backend still installs its entries. New: it has no install manifest yet.
    if (text === undefined || !known.has(`${fullTree}:${path}`) || REDIRECTED_JAR.test(text)) {
      escalating.push(path);
    }
  }
  return escalating;
}

/** The changed front-end files the object directory does not already serve. */
async function unserved(workspace: Workspace, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { engineDir, objDir } = workspace;
  const index = await readInstallIndex(engineDir, objDir);
  const remaining: string[] = [];
  for (const path of paths) {
    if (!(await exists(join(engineDir, path)))) {
      // A deleted file is served by nothing; whether it was ever packaged is all that matters.
      if (!isTestPath(path)) remaining.push(path);
      continue;
    }
    const delivery = index === undefined ? 'unlisted' : await deliveryOf(index, engineDir, path);
    if (delivery === 'live' || delivery === 'at-test') continue;
    if (delivery === 'unlisted' && isTestPath(path)) continue;
    remaining.push(path);
  }
  return remaining;
}

/**
 * Whether the workspace's development build matches its engine.
 *
 * @param workspace - The workspace
 * @returns `fresh`, or what changed and the smallest build that catches up
 */
export async function buildStaleness(workspace: Workspace): Promise<BuildStaleness> {
  const { engineDir, objDir, project } = workspace;
  const baseline = await readBuildBaseline(workspace);
  if (baseline === undefined) return stale('full', 'no build of this workspace is recorded');
  if ((await findBrowserBinary(objDir, project.config.binaryName)) === undefined) {
    return stale('full', 'the object directory holds no launchable browser');
  }
  if ((await movedFrom(workspace)) !== undefined) {
    return stale(
      'full',
      'the object directory was configured at another path and cannot be used here'
    );
  }
  if (digest(await renderMozconfig(workspace)) !== baseline.mozconfig) {
    return stale('full', 'the build configuration (configs/ or the identity) changed', [
      'mozconfig',
    ]);
  }
  for (const snapshot of [baseline.tree, baseline.fullTree]) {
    if ((await resolveRevision(engineDir, snapshot, 'commit')) === undefined) {
      return stale('full', "the engine's repository does not hold the recorded build");
    }
  }
  const now = await captureWorktree(engineDir);
  const sinceFull = await changedPaths(engineDir, baseline.fullTree, now);
  const sinceLast =
    baseline.tree === baseline.fullTree
      ? sinceFull
      : await changedPaths(engineDir, baseline.tree, now);

  const compiled = sinceFull.filter((path) => buildInputClass(path) === 'full');
  const jars = await escalatingJars(
    engineDir,
    sinceFull.filter((path) => buildInputClass(path) === 'jar'),
    baseline.fullTree
  );
  if (compiled.length > 0 || jars.length > 0) {
    const what = [
      ...(compiled.length > 0 ? [`${compiled.length} compiled source or build definition`] : []),
      ...(jars.length > 0 ? [`${jars.length} jar.mn the build backend must regenerate for`] : []),
    ];
    return stale('full', `${what.join(' and ')} changed since the last full build`, [
      ...compiled,
      ...jars,
    ]);
  }
  const frontEnd = [
    ...sinceLast.filter((path) => buildInputClass(path) === 'jar'),
    ...(await unserved(
      workspace,
      sinceLast.filter((path) => buildInputClass(path) === 'ui')
    )),
  ];
  return frontEnd.length === 0
    ? { state: 'fresh' }
    : stale(
        'ui',
        `${frontEnd.length} packaged front-end file(s) changed since the last build`,
        frontEnd
      );
}
