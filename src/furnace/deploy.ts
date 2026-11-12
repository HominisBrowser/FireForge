// SPDX-License-Identifier: EUPL-1.2
/**
 * Deploying components into an engine.
 *
 * Deployment is a comparison of two states: what the project's components
 * want the engine to hold (each component file at its engine path, CSS
 * fragments inlined; the jar.mn lines; the customElements.js entries) and
 * what the engine holds. Whatever differs is written, in one transaction
 * together with the deployment record, so an error, a signal or a crash
 * leaves the engine and its record as they were, and the next run undoes an
 * interrupted one before planning.
 *
 * The record (`furnace-deployment.json` in the workspace's state directory)
 * says what each component deployed. It describes the engine, not the
 * project, and serves one purpose the comparison cannot: knowing what to
 * take away. A file a component no longer has, or every file of a component
 * no longer configured, is removed; an override's file is put back to the
 * upstream bytes at the engine's `HEAD`. Everything else is decided from the
 * bytes on disk, so a reset engine, a hand edit or a lost record is repaired
 * by the next run, and an unchanged component costs a read and a hash.
 */
import { join, posix } from 'node:path';

import { markerComment } from '../config/index.js';
import { listTree, readBlobs } from '../git/index.js';
import { ExitCode, type FireForgeError } from '../kernel/errors.js';
import {
  listDir,
  pathInfo,
  readBytes,
  readBytesIfExists,
  readTextIfExists,
  resolveContained,
} from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { recoverJournal, transaction } from '../kernel/journal.js';
import { readJsonIfExists, stringifyJson } from '../kernel/json.js';
import { withLock } from '../kernel/lock.js';
import { type Infer, s } from '../kernel/schema.js';
import { elementJarEntry, type JarFile } from '../register/index.js';
import {
  componentDir,
  type ComponentKind,
  CUSTOM_ELEMENTS_JS,
  type CustomComponent,
  fragmentsDir,
  ftlDir,
  type FurnaceConfig,
  furnaceError,
  type FurnaceProject,
  jarSourceDir,
  loadFurnaceConfig,
  type OverrideComponent,
  WIDGETS_JAR,
} from './config.js';
import { expandFragments } from './fragments.js';
import {
  elementEntries,
  missingJarFiles,
  planJar,
  registerElement,
  unregisterElement,
} from './registration.js';

/** The engine Furnace deploys into. */
export interface FurnaceWorkspace {
  /** The engine: a git work tree whose `HEAD` holds the upstream files. */
  readonly engineDir: string;
  /** Where the deployment record, its journal and its lock live. */
  readonly stateDir: string;
}

const DeployedComponent = s.object({
  kind: s.enum(['custom', 'override']),
  /** Engine path to the SHA-256 of the bytes deployed there. */
  files: s.record(s.string()),
  /** Listed in customElements.js. */
  registered: s.boolean(),
  /** The jar.mn source directory the component's lines point into. */
  jarDir: s.string().optional(),
});

const DeploymentRecord = s.object({
  version: s.literal(1),
  components: s.record(DeployedComponent),
});
type DeploymentRecord = Infer<typeof DeploymentRecord>;
type DeployedComponent = Infer<typeof DeployedComponent>;

const RECORD_FILE = 'furnace-deployment.json';
const JOURNAL_FILE = 'furnace-deployment.journal';
const LOCK_DIR = 'furnace.lock';

/** Where one component stands against the engine. */
export type ComponentDeployment = {
  name: string;
  kind: ComponentKind;
  /** `outdated`: the engine lacks some of it; `removed`: deployed, no longer configured. */
  status: 'current' | 'outdated' | 'removed';
  /** Why it is not current, one entry per difference. */
  reasons: string[];
};

/** What a deployment did, or for a dry run would do. */
export type DeploymentResult = {
  /** Whether the engine was (or would be) changed. */
  changed: boolean;
  components: ComponentDeployment[];
  /** Engine paths written, including jar.mn and customElements.js. */
  written: string[];
  /** Engine paths removed or put back to upstream. */
  removed: string[];
};

/** What one configured component wants deployed. */
interface Wanted {
  name: string;
  kind: ComponentKind;
  files: Map<string, Buffer>;
  registered: boolean;
  jarDir?: string;
  jar: JarFile[];
}

interface Plan {
  writes: Map<string, Buffer>;
  /** Engine path to the upstream bytes to put back, or null to delete. */
  removals: Map<string, Buffer | null>;
  jar: string | undefined;
  elements: string | undefined;
  record: DeploymentRecord;
  recordChanged: boolean;
  components: ComponentDeployment[];
}

function missingComponent(kind: ComponentKind, name: string): FireForgeError {
  return furnaceError(
    'furnace-component-missing',
    `furnace.json lists ${kind} component "${name}", but components/${kind === 'custom' ? 'custom' : 'overrides'}/${name}/ does not exist.`,
    {
      hint: `Restore the directory, or remove the component with "fireforge furnace remove ${name}".`,
    }
  );
}

/** The regular files of a component directory, by name. */
async function sourceFiles(dir: string): Promise<string[] | undefined> {
  if ((await pathInfo(dir))?.kind !== 'directory') return undefined;
  return (await listDir(dir)).filter((entry) => entry.kind === 'file').map((entry) => entry.name);
}

/** Whether an override of this type deploys the file. */
export function overrideDeploys(type: OverrideComponent['type'], file: string): boolean {
  if (file === 'override.json') return false;
  return type === 'css-only' ? file.endsWith('.css') : /\.(?:mjs|css|ftl)$/.test(file);
}

async function wantedOverride(
  project: FurnaceProject,
  config: FurnaceConfig,
  name: string,
  entry: OverrideComponent
): Promise<Wanted> {
  const dir = componentDir(project, 'override', name);
  const names = await sourceFiles(dir);
  if (names === undefined) throw missingComponent('override', name);
  const files = new Map<string, Buffer>();
  for (const file of names.filter((candidate) => overrideDeploys(entry.type, candidate))) {
    const target = file.endsWith('.ftl') ? ftlDir(config) : entry.basePath;
    files.set(`${target}/${file}`, await readBytes(join(dir, file)));
  }
  if (files.size === 0) {
    throw furnaceError(
      'furnace-component-empty',
      `Override "${name}" has no file to deploy (${entry.type === 'css-only' ? '.css' : '.mjs, .css or .ftl'}).`
    );
  }
  return { name, kind: 'override', files, registered: false, jar: [] };
}

async function wantedCustom(
  project: FurnaceProject,
  config: FurnaceConfig,
  name: string,
  entry: CustomComponent
): Promise<Wanted> {
  const dir = componentDir(project, 'custom', name);
  const names = await sourceFiles(dir);
  if (names === undefined) throw missingComponent('custom', name);
  const jarDir = jarSourceDir(entry.targetPath);
  const files = new Map<string, Buffer>();
  const jar: JarFile[] = [];
  for (const file of names.filter((candidate) => /\.(?:mjs|css)$/.test(candidate))) {
    let content = await readBytes(join(dir, file));
    if (file.endsWith('.css')) {
      content = Buffer.from(await expandFragments(content.toString('utf8'), fragmentsDir(project)));
    }
    files.set(`${entry.targetPath}/${file}`, content);
    jar.push(elementJarEntry(jarDir, file));
  }
  if (entry.localized && entry.sharedFtl === undefined && names.includes(`${name}.ftl`)) {
    files.set(`${ftlDir(config)}/${name}.ftl`, await readBytes(join(dir, `${name}.ftl`)));
  }
  // Without its module the entry would name a script that does not exist.
  const registered = entry.register && names.includes(`${name}.mjs`);
  return { name, kind: 'custom', files, registered, jarDir, jar };
}

async function wantedComponents(project: FurnaceProject, config: FurnaceConfig): Promise<Wanted[]> {
  const wanted: Wanted[] = [];
  for (const [name, entry] of Object.entries(config.overrides)) {
    wanted.push(await wantedOverride(project, config, name, entry));
  }
  for (const [name, entry] of Object.entries(config.custom)) {
    wanted.push(await wantedCustom(project, config, name, entry));
  }
  return wanted;
}

/**
 * The engine files every configured component deploys, read from the
 * project's component sources without an engine.
 *
 * @param project - The project
 * @param config - Its component configuration
 * @returns Per component, the content by engine path
 * @throws `furnace-component-missing` or `furnace-component-empty` (exit code 9)
 */
export async function componentFiles(
  project: FurnaceProject,
  config: FurnaceConfig
): Promise<{ name: string; files: Map<string, Buffer> }[]> {
  return (await wantedComponents(project, config)).map(({ name, files }) => ({ name, files }));
}

async function readRecord(workspace: FurnaceWorkspace): Promise<DeploymentRecord> {
  const path = join(workspace.stateDir, RECORD_FILE);
  const record = await readJsonIfExists(path, DeploymentRecord, {
    code: 'furnace-deployment-invalid',
    exitCode: ExitCode.CONFIG_ERROR,
    hint: `Delete ${path} and run "fireforge furnace apply"; files of components removed since the last deployment then stay in the engine.`,
  });
  return record ?? { version: 1, components: {} };
}

/** Compares one component's files with the engine, filling the plan. */
async function planFiles(
  workspace: FurnaceWorkspace,
  wanted: Wanted,
  previous: DeployedComponent | undefined,
  plan: Plan
): Promise<{ reasons: string[]; hashes: Record<string, string> }> {
  const reasons: string[] = [];
  const hashes: Record<string, string> = {};
  for (const [path, content] of wanted.files) {
    const digest = hash(content);
    hashes[path] = digest;
    const engine = await readBytesIfExists(await resolveContained(workspace.engineDir, path));
    if (engine !== undefined && hash(engine) === digest) continue;
    plan.writes.set(path, content);
    const recorded = previous?.kind === wanted.kind ? previous.files[path] : undefined;
    reasons.push(
      recorded === undefined
        ? `${path} is not deployed`
        : recorded !== digest
          ? `${path} changed in the project`
          : `${path} ${engine === undefined ? 'is missing from' : 'was changed in'} the engine`
    );
  }
  return { reasons, hashes };
}

/** Records the engine paths of a deployed component that are no longer wanted, with their owner's kind. */
function planRemovals(
  previous: DeployedComponent,
  keep: ReadonlyMap<string, Buffer> | undefined,
  gone: Map<string, ComponentKind>
): string[] {
  const paths = Object.keys(previous.files).filter((path) => keep?.has(path) !== true);
  for (const path of paths) gone.set(path, previous.kind);
  return paths;
}

/**
 * What to do with each path taken away: a custom component's file is
 * deleted, an override's is put back to upstream (deleted where upstream
 * has none). A path another component now writes is left to that write.
 */
async function resolveRemovals(
  workspace: FurnaceWorkspace,
  gone: ReadonlyMap<string, ComponentKind>,
  writes: ReadonlyMap<string, Buffer>
): Promise<Map<string, Buffer | null>> {
  const paths = [...gone.keys()].filter((path) => !writes.has(path));
  const restore = paths.filter((path) => gone.get(path) === 'override');
  const upstream =
    restore.length === 0 ? new Map<string, Buffer>() : await upstreamFiles(workspace, restore);
  return new Map(paths.map((path) => [path, upstream.get(path) ?? null]));
}

async function assertOverrideTargets(
  workspace: FurnaceWorkspace,
  config: FurnaceConfig
): Promise<void> {
  for (const [name, entry] of Object.entries(config.overrides)) {
    const target = await resolveContained(workspace.engineDir, entry.basePath);
    if ((await pathInfo(target))?.kind !== 'directory') {
      throw furnaceError(
        'furnace-override-target-missing',
        `Override "${name}" replaces files in ${entry.basePath}, which the engine does not have.`,
        { hint: 'Correct its basePath in furnace.json, or remove the override.' }
      );
    }
  }
}

async function readEngineFile(workspace: FurnaceWorkspace, path: string): Promise<string> {
  const text = await readTextIfExists(join(workspace.engineDir, path));
  if (text !== undefined) return text;
  throw furnaceError('furnace-engine-incomplete', `The engine has no ${path}.`, {
    hint: 'Components register in it; restore the engine from upstream.',
  });
}

/** Plans the jar.mn lines, attributing missing ones to their components. */
async function planJarFile(
  workspace: FurnaceWorkspace,
  wanted: readonly Wanted[],
  ownedDirs: readonly string[],
  reasons: Map<string, string[]>
): Promise<string | undefined> {
  const lines = wanted.flatMap((component) => component.jar);
  if (lines.length === 0 && ownedDirs.length === 0) return undefined;
  const text = await readEngineFile(workspace, WIDGETS_JAR);
  const next = planJar(text, lines, ownedDirs);
  if (next === text) return undefined;
  for (const component of wanted) {
    const missing = missingJarFiles(text, component.jar);
    if (missing.length > 0) {
      reasons
        .get(component.name)
        ?.push(`${WIDGETS_JAR} lacks ${missing.map((file) => file.target).join(', ')}`);
    }
  }
  return next;
}

/** Plans the customElements.js entries: owned tags no longer wanted go, wanted tags are listed. */
async function planElements(
  workspace: FurnaceWorkspace,
  marker: string,
  wantedTags: readonly string[],
  ownedTags: readonly string[],
  reasons: Map<string, string[]>
): Promise<string | undefined> {
  if (wantedTags.length === 0 && ownedTags.length === 0) return undefined;
  const text = await readEngineFile(workspace, CUSTOM_ELEMENTS_JS);
  let next = text;
  for (const tag of ownedTags.filter((owned) => !wantedTags.includes(owned))) {
    next = unregisterElement(next, tag);
  }
  const listed = new Set(
    elementEntries(text)
      .filter((entry) => entry.module)
      .map((entry) => entry.tag)
  );
  for (const tag of wantedTags) {
    const before = next;
    next = registerElement(next, tag, marker);
    if (!listed.has(tag) && next !== before) {
      reasons.get(tag)?.push(`${CUSTOM_ELEMENTS_JS} does not list it as a module element`);
    }
  }
  return next === text ? undefined : next;
}

async function makePlan(
  project: FurnaceProject,
  workspace: FurnaceWorkspace,
  config: FurnaceConfig
): Promise<Plan> {
  const previous = await readRecord(workspace);
  const wanted = await wantedComponents(project, config);
  await assertOverrideTargets(workspace, config);
  const plan: Plan = {
    writes: new Map(),
    removals: new Map(),
    jar: undefined,
    elements: undefined,
    record: { version: 1, components: {} },
    recordChanged: false,
    components: [],
  };
  const reasons = new Map<string, string[]>();
  const gone = new Map<string, ComponentKind>();
  for (const component of wanted) {
    const before = previous.components[component.name];
    const files = await planFiles(workspace, component, before, plan);
    if (before !== undefined) {
      const keep = before.kind === component.kind ? component.files : undefined;
      const dropped = planRemovals(before, keep, gone);
      files.reasons.push(...dropped.map((path) => `${path} is no longer part of it`));
    }
    reasons.set(component.name, files.reasons);
    plan.record.components[component.name] = {
      kind: component.kind,
      files: files.hashes,
      registered: component.registered,
      ...(component.jarDir === undefined ? {} : { jarDir: component.jarDir }),
    };
  }
  const configured = new Set(wanted.map((component) => component.name));
  const removed = Object.entries(previous.components).filter(([name]) => !configured.has(name));
  for (const [, before] of removed) planRemovals(before, undefined, gone);
  plan.removals = await resolveRemovals(workspace, gone, plan.writes);

  const ownedDirs = [
    ...new Set(
      [
        ...wanted.map((component) => component.jarDir),
        ...Object.values(previous.components).map((c) => c.jarDir),
      ].filter((dir): dir is string => dir !== undefined)
    ),
  ];
  plan.jar = await planJarFile(workspace, wanted, ownedDirs, reasons);
  const wantedTags = wanted
    .filter((component) => component.registered)
    .map((component) => component.name);
  const ownedTags = Object.entries(previous.components)
    .filter(([, before]) => before.registered)
    .map(([name]) => name);
  plan.elements = await planElements(
    workspace,
    markerComment(project.config),
    wantedTags,
    ownedTags,
    reasons
  );

  plan.components = [
    ...wanted.map((component): ComponentDeployment => {
      const why = reasons.get(component.name) ?? [];
      return {
        name: component.name,
        kind: component.kind,
        status: why.length === 0 ? 'current' : 'outdated',
        reasons: why,
      };
    }),
    ...removed.map(([name, before]): ComponentDeployment => ({
      name,
      kind: before.kind,
      status: 'removed',
      reasons: ['it is no longer in furnace.json'],
    })),
  ];
  plan.recordChanged = JSON.stringify(plan.record) !== JSON.stringify(previous);
  return plan;
}

function engineChanges(plan: Plan): boolean {
  return (
    plan.writes.size > 0 ||
    plan.removals.size > 0 ||
    plan.jar !== undefined ||
    plan.elements !== undefined
  );
}

function summarize(plan: Plan): DeploymentResult {
  return {
    changed: engineChanges(plan),
    components: plan.components,
    written: [
      ...plan.writes.keys(),
      ...[...plan.removals].filter(([, bytes]) => bytes !== null).map(([path]) => path),
      ...(plan.jar === undefined ? [] : [WIDGETS_JAR]),
      ...(plan.elements === undefined ? [] : [CUSTOM_ELEMENTS_JS]),
    ].sort(),
    removed: [...plan.removals.keys()].sort(),
  };
}

/** How {@link applyComponents} runs. */
export interface ApplyOptions {
  /** Plan and report without writing. */
  dryRun?: boolean;
  /** How long to wait for another deployment into the same workspace, in milliseconds. */
  waitMs?: number | undefined;
}

/**
 * Deploys the project's components into a workspace's engine: writes every
 * component file whose engine copy differs, removes what components no
 * longer have, and brings jar.mn and customElements.js in line, all in one
 * transaction with the deployment record. Unchanged components cost a read
 * and a hash; with nothing to change nothing is written.
 *
 * @param project - The project whose `furnace.json` and `components/` are deployed
 * @param workspace - The engine to deploy into
 * @param options - See {@link ApplyOptions}
 * @throws `furnace-component-missing`, `furnace-override-target-missing`,
 *   `furnace-fragment-missing`, `furnace-engine-incomplete`, `manifest-invalid`
 *   (a jar.mn conflict) or `furnace-custom-elements-unreadable`; the engine is then unchanged
 */
export async function applyComponents(
  project: FurnaceProject,
  workspace: FurnaceWorkspace,
  options: ApplyOptions = {}
): Promise<DeploymentResult> {
  const journal = join(workspace.stateDir, JOURNAL_FILE);
  const lockOptions = {
    label: 'furnace deployment',
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  };
  return withLock(join(workspace.stateDir, LOCK_DIR), lockOptions, async () => {
    if (options.dryRun !== true) await recoverJournal(journal);
    const plan = await makePlan(project, workspace, await loadFurnaceConfig(project));
    const result = summarize(plan);
    if (options.dryRun === true || (!result.changed && !plan.recordChanged)) return result;
    await transaction(journal, 'the component deployment', async (tx) => {
      const at = (path: string): Promise<string> => resolveContained(workspace.engineDir, path);
      for (const [path, content] of plan.writes) await tx.write(await at(path), content);
      for (const [path, upstream] of plan.removals) {
        if (upstream === null) await tx.remove(await at(path));
        else await tx.write(await at(path), upstream);
      }
      if (plan.jar !== undefined) await tx.write(join(workspace.engineDir, WIDGETS_JAR), plan.jar);
      if (plan.elements !== undefined) {
        await tx.write(join(workspace.engineDir, CUSTOM_ELEMENTS_JS), plan.elements);
      }
      await tx.write(join(workspace.stateDir, RECORD_FILE), stringifyJson(plan.record));
    });
    return result;
  });
}

/** Whether a workspace's deployed components match the project. */
export type DeploymentStatus = {
  /** True when deploying would change nothing in the engine. */
  current: boolean;
  components: ComponentDeployment[];
};

/**
 * Compares the deployed components with the project without changing
 * anything: the question a build asks before deciding to apply first.
 *
 * @param project - The project
 * @param workspace - The engine to compare
 */
export async function deploymentStatus(
  project: FurnaceProject,
  workspace: FurnaceWorkspace
): Promise<DeploymentStatus> {
  const plan = await makePlan(project, workspace, await loadFurnaceConfig(project));
  return { current: !engineChanges(plan), components: plan.components };
}

/**
 * The upstream bytes of engine paths at the engine's `HEAD`.
 *
 * @param workspace - The engine
 * @param paths - Engine paths
 * @returns Content by path; a path upstream does not have is absent
 */
export async function upstreamFiles(
  workspace: FurnaceWorkspace,
  paths: readonly string[]
): Promise<Map<string, Buffer>> {
  const blobs = await readBlobs(
    workspace.engineDir,
    paths.map((path) => `HEAD:${path}`)
  );
  return new Map(
    paths.flatMap((path) => {
      const blob = blobs.get(`HEAD:${path}`);
      return blob === undefined ? [] : [[path, blob] as const];
    })
  );
}

/**
 * The upstream files of an engine directory at `HEAD`, by name (one level).
 *
 * @param workspace - The engine
 * @param dir - Engine directory
 */
export async function upstreamDirectory(
  workspace: FurnaceWorkspace,
  dir: string
): Promise<string[]> {
  const entries = await listTree(workspace.engineDir, 'HEAD', { paths: [dir] });
  return entries
    .filter((entry) => entry.type === 'blob' && posix.dirname(entry.path) === dir)
    .map((entry) => posix.basename(entry.path));
}

/** The deployed content each component file wants, for comparing with the engine. */
export async function deployedContent(
  project: FurnaceProject,
  config: FurnaceConfig,
  name: string
): Promise<Map<string, Buffer>> {
  const entry = config.custom[name];
  if (entry !== undefined) return (await wantedCustom(project, config, name, entry)).files;
  const override = config.overrides[name];
  return override === undefined
    ? new Map()
    : (await wantedOverride(project, config, name, override)).files;
}
