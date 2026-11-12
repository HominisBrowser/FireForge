// SPDX-License-Identifier: EUPL-1.2
/**
 * Either storage as the owned-change model, and what the judging modules
 * read beside it: the engine files around the changes and the design-token
 * policy. Group waivers and tiers the configuration declares are merged in
 * here, so they apply whichever mode produced the groups.
 */
import { join, relative } from 'node:path';

import type { FireForgeConfig, ProjectMode } from '../config/index.js';
import { listPristineTree, readPristineFiles, type Workspace } from '../engine/index.js';
import { componentFiles, componentHostFiles, loadFurnaceConfig } from '../furnace/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists, readBytesIfExists, toPosixPath } from '../kernel/fs.js';
import type { EngineReader, TokenPolicy } from '../lint/index.js';
import {
  type ChangeGroup,
  type ChangeSet,
  createChangeSet,
  type LintIgnoreEntry,
  type OwnedChange,
  type Project,
  type SourceProject,
  textContent,
} from '../project/index.js';
import { engineChanges, queueChanges } from '../queue/index.js';
import { readSourceFile, sourceChanges } from '../source/index.js';
import { pinnedPristine, requireEngine } from './pristine.js';
import { trackedFiles } from './tracked.js';

/** Which owned changes are asked for. */
export interface OwnedScope {
  /**
   * `engine` (default): what the engine ends up holding, one step per path.
   * `queue`: the stored patch queue, one step per patch per path. A
   * source-mode project has one view, which both name.
   */
  scope?: 'engine' | 'queue' | undefined;
}

/**
 * What a waiver's `group` may spell to mean a group: its ID, and for a patch
 * also the patch's name (`ui-sidebar` of `012-ui-sidebar.patch`), which a
 * reorder does not change.
 */
function waiverNames(mode: ProjectMode, group: ChangeGroup): string[] {
  return mode === 'patches'
    ? [group.id, group.id.replace(/^\d+-/, '').replace(/\.patch$/, '')]
    : [group.id];
}

function configuredWaivers(project: Project, group: ChangeGroup): LintIgnoreEntry[] {
  const names = waiverNames(project.mode, group);
  return (project.config.patchLint.waivers ?? [])
    .filter((waiver) => names.includes(waiver.group))
    .map((waiver) =>
      waiver.max === undefined
        ? waiver.rule
        : {
            rule: waiver.rule,
            max: waiver.max,
            reason: waiver.reason,
            ...(waiver.share === undefined ? {} : { share: waiver.share }),
          }
    );
}

function configuredTier(config: FireForgeConfig, group: ChangeGroup): 'branding' | undefined {
  return group.meta['kind'] === 'created'
    ? config.exportQueue.groups?.find((entry) => entry.name === group.id)?.tier
    : config.exportQueue.componentTiers?.[group.id];
}

/** The change set with the configuration's waivers and tiers merged into its groups. */
function withConfiguredGroups(project: Project, changes: ChangeSet): ChangeSet {
  const groups = changes.groups.map((group): ChangeGroup => {
    const lintIgnore = [...(group.lintIgnore ?? []), ...configuredWaivers(project, group)];
    const tier = group.tier ?? configuredTier(project.config, group);
    return {
      ...group,
      ...(tier === undefined ? {} : { tier }),
      ...(lintIgnore.length === 0 ? {} : { lintIgnore }),
    };
  });
  return createChangeSet({
    groups,
    changes: changes.changes,
    ...(changes.diff === undefined ? {} : { diff: changes.diff }),
  });
}

/**
 * The project's owned changes. Patch mode reads the engine's current state
 * (or, with `scope: 'queue'`, the stored queue patch by patch); source mode
 * reads the owned files against the pinned pristine repository and needs no
 * engine.
 *
 * @param project - The project
 * @param options - See {@link OwnedScope}
 * @throws `pristine-missing` or `engine-missing` before `download`,
 *   `queue-does-not-apply` for a stored queue that does not replay
 */
export async function ownedChanges(project: Project, options: OwnedScope = {}): Promise<ChangeSet> {
  if (project.mode === 'source') {
    const changes = await sourceChanges(project, await pinnedPristine(project));
    return withConfiguredGroups(project, changes);
  }
  await requireEngine(project);
  const changes =
    options.scope === 'queue' ? await queueChanges(project) : await engineChanges(project);
  return withConfiguredGroups(project, changes);
}

/** A group of the files one Furnace component deploys, as `status --groups` lists it. */
export interface ComponentGroup {
  /** The component's name, which is the group's ID. */
  readonly id: string;
  /** Engine paths the component deploys. */
  readonly paths: readonly string[];
}

/** The files each Furnace component of a source-mode project deploys, read from `components/`. */
async function deployedComponents(
  project: SourceProject
): Promise<{ name: string; files: Map<string, Buffer> }[]> {
  if (!(await exists(project.paths.furnace))) return [];
  return componentFiles(project, await loadFurnaceConfig(project));
}

/**
 * The groups of files a source-mode project's Furnace components deploy.
 *
 * @param project - A source-mode project
 */
export async function componentGroups(project: SourceProject): Promise<ComponentGroup[]> {
  return (await deployedComponents(project)).map(({ name, files }) => ({
    id: name,
    paths: [...files.keys()].sort(),
  }));
}

/**
 * The checkout directories whose files an engine holds, for a mutation
 * written against the checkout: a source-mode project's source root, and
 * each Furnace component's directory, whose modules and stylesheets deploy
 * into the component's engine directory.
 *
 * @param project - The project
 */
export async function mutationRoots(
  project: Project
): Promise<{ directory: string; engine: string }[]> {
  const roots =
    project.mode === 'source' ? [{ directory: project.config.source.root, engine: '' }] : [];
  if (!(await exists(project.paths.furnace))) return roots;
  const furnace = await loadFurnaceConfig(project);
  const components = toPosixPath(relative(project.root, project.paths.components));
  return [
    ...roots,
    ...Object.entries(furnace.custom).map(([name, entry]) => ({
      directory: `${components}/custom/${name}`,
      engine: entry.targetPath,
    })),
    ...Object.entries(furnace.overrides).map(([name, entry]) => ({
      directory: `${components}/overrides/${name}`,
      engine: entry.basePath,
    })),
  ];
}

/**
 * A source-mode change set with the files the project's Furnace components
 * deploy: they are engine files the project supplies, kept under
 * `components/` instead of the source root, and a build holds them like any
 * owned file. Each component is one group, named after it. A path the
 * source root also owns stays the source root's.
 */
async function withComponentFiles(project: SourceProject, changes: ChangeSet): Promise<ChangeSet> {
  const components = await deployedComponents(project);
  if (components.length === 0) return changes;
  const pristine = await pinnedPristine(project);
  const taken = new Set(changes.groups.map((group) => group.id));
  const groups: ChangeGroup[] = [];
  const added: OwnedChange[] = [];
  for (const { name, files } of components) {
    if (taken.has(name)) {
      throw new FireForgeError(
        'source-group-name-collision',
        `Group "${name}" would hold both owned files and the files of Furnace component ${name}.`,
        {
          exitCode: ExitCode.CONFIG_ERROR,
          hint: "Give the exportQueue group or the override records' component another name.",
        }
      );
    }
    const paths = [...files.keys()].filter((path) => changes.at(path).length === 0);
    const upstream = new Map(
      (paths.length === 0 ? [] : await listPristineTree(pristine, paths)).map((entry) => [
        entry.path,
        entry,
      ])
    );
    const group: ChangeGroup = {
      id: name,
      sized: false,
      meta: { kind: 'furnace', description: `Files of Furnace component ${name}` },
    };
    const lintIgnore = configuredWaivers(project, group);
    groups.push(lintIgnore.length === 0 ? group : { ...group, lintIgnore });
    for (const path of paths) {
      const content = files.get(path) ?? Buffer.alloc(0);
      const base = {
        path,
        group: name,
        binary: textContent(content) === undefined,
        meta: { furnace: name },
        after: () => Promise.resolve(content),
        mode: '100644' as const,
      };
      const entry = upstream.get(path);
      if (entry === undefined) {
        added.push({ ...base, kind: 'create' });
      } else {
        added.push({
          ...base,
          kind: 'modify',
          previousMode: entry.mode === '100755' ? '100755' : '100644',
          before: async () =>
            (await readPristineFiles(pristine, [path])).get(path) ?? Buffer.alloc(0),
        });
      }
    }
  }
  return createChangeSet({
    groups: [...changes.groups, ...groups],
    changes: [...changes.changes, ...added],
    ...(changes.diff === undefined ? {} : { diff: changes.diff }),
  });
}

/**
 * Reads engine files as the project builds them: a patch-mode project's
 * `engine/`, a leased workspace's engine, or (source mode without a
 * workspace) the owned files and the files Furnace deploys, over the
 * pristine blobs.
 *
 * @param project - The project
 * @param workspace - A workspace already holding the project's source, when the caller has one
 */
async function engineReader(project: Project, workspace?: Workspace): Promise<EngineReader> {
  const onDisk = (engineDir: string): EngineReader => ({
    read: (path) => readBytesIfExists(join(engineDir, path)),
  });
  if (project.mode === 'patches') return onDisk(project.paths.engine);
  if (workspace !== undefined) return onDisk(workspace.engineDir);
  const pristine = await pinnedPristine(project);
  const deployed = new Map((await deployedComponents(project)).flatMap(({ files }) => [...files]));
  return {
    read: async (path) => (await readSourceFile(project, pristine, path)) ?? deployed.get(path),
  };
}

/**
 * Where a project keeps the TypeScript result cache `lint` and `typecheck` share.
 *
 * @param project - The project
 */
export function typeCacheDir(project: Project): string {
  return join(project.paths.stateDir, 'cache', 'typescript');
}

/** What `lint` and `typecheck` judge. */
export interface LintSubject {
  readonly changes: ChangeSet;
  readonly engine: EngineReader;
  /** The groups apply one after another (a patch queue). */
  readonly sequential: boolean;
  /** Design-token naming from the component configuration, when it declares a prefix. */
  readonly tokens?: TokenPolicy;
  /** Engine paths of the component host files, which Furnace validation judges. */
  readonly components: readonly string[];
}

/**
 * The owned changes with everything a lint run reads beside them.
 *
 * @param project - The project
 * @param options - See {@link OwnedScope}; `workspace` reads the engine there
 */
export async function lintSubject(
  project: Project,
  options: OwnedScope & { workspace?: Workspace } = {}
): Promise<LintSubject> {
  const furnace = (await exists(project.paths.furnace))
    ? await loadFurnaceConfig(project)
    : undefined;
  const owned = await ownedChanges(project, options);
  return {
    changes: project.mode === 'source' ? await withComponentFiles(project, owned) : owned,
    engine: await engineReader(project, options.workspace),
    sequential: project.mode === 'patches',
    components: furnace === undefined ? [] : componentHostFiles(furnace),
    ...(furnace?.tokenPrefix === undefined
      ? {}
      : {
          tokens: {
            prefix: furnace.tokenPrefix,
            allowlist: furnace.tokenAllowlist ?? [],
            runtimeVariables: furnace.runtimeVariables ?? [],
          },
        }),
  };
}

/** The engine files a project owns and still holds, readable as the project builds them. */
export interface OwnedFiles {
  /** Engine paths, deletions left out. */
  readonly paths: string[];
  /** Reads an engine path from the project's tracked files. */
  read(path: string): Promise<string | undefined>;
}

/**
 * The engine files the project owns and still holds: what token coverage
 * and token lint judge. In patch mode the caller holds the engine still
 * (`withOwnedRead`) while it reads them.
 *
 * @param project - The project
 */
export async function ownedFiles(project: Project): Promise<OwnedFiles> {
  const files = await trackedFiles(project);
  return {
    paths: (await ownedChanges(project))
      .net()
      .filter((change) => change.kind !== 'delete')
      .map((change) => change.path),
    read: (path) => files.read(path),
  };
}
