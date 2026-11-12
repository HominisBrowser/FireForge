// SPDX-License-Identifier: EUPL-1.2
/**
 * Moving a patch-mode project to source mode: the queue is replayed onto the
 * pristine commit, the resulting tree is adopted as owned files and override
 * records, and `fireforge.json` takes the `mode` and `source` keys plus what
 * the manifest carried per patch (tier, waivers) and the created-file groups
 * that keep each patch's files together in an export.
 *
 * The conversion is in place and needs a committed git tree: everything
 * written is undone on failure, and afterwards `git` is the undo.
 */
import { join, relative } from 'node:path';

import { CONFIG_FILE, configSchema, readConfigDocument } from '../config/index.js';
import { listTree, status as gitStatus } from '../git/index.js';
import { defined, ExitCode, FireForgeError } from '../kernel/errors.js';
import { remove, toPosixPath, writeFile } from '../kernel/fs.js';
import { isRecord, type JsonObject, stringifyJson } from '../kernel/json.js';
import { loadProject, type Project, type SourceProject } from '../project/index.js';
import { type Queue, readQueue, replayQueue, requirePatchMode } from '../queue/index.js';
import {
  type Adopted,
  adoptTrees,
  installMergeDriver,
  requireSourceMode,
  sourceChanges,
} from '../source/index.js';
import { ownedTree } from './export.js';
import { pinnedPristine } from './pristine.js';

const SOURCE_ROOT = 'src';
const METADATA_ROOT = '.fireforge-sources';

/** What {@link migrate} did. */
export type Migration = {
  /** Engine paths now owned, by what the queue did to them. */
  created: string[];
  overridden: string[];
  deleted: string[];
  /** The pristine commit the records name. */
  pristineCommit: string;
};

const ancestors = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};

/**
 * The globs that select each patch's created files: `<dir>/**` for the
 * shallowest directory the project itself created whose files all belong to
 * that patch, else the file. A directory upstream has is never claimed
 * whole, so a file created there later is not swept into the group.
 */
function createdGlobs(
  owners: ReadonlyMap<string, string>,
  upstream: ReadonlySet<string>
): Map<string, string[]> {
  const directoryOwners = new Map<string, Set<string>>();
  for (const [path, owner] of owners) {
    for (const directory of ancestors(path)) {
      directoryOwners.set(directory, (directoryOwners.get(directory) ?? new Set()).add(owner));
    }
  }
  const globs = new Map<string, Set<string>>();
  for (const [path, owner] of owners) {
    const whole = ancestors(path).find(
      (directory) => !upstream.has(directory) && directoryOwners.get(directory)?.size === 1
    );
    globs.set(
      owner,
      (globs.get(owner) ?? new Set()).add(whole === undefined ? path : `${whole}/**`)
    );
  }
  return new Map(
    [...globs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([owner, set]) => [owner, [...set].sort()])
  );
}

function section(document: JsonObject, key: string): JsonObject {
  const value = document[key];
  return isRecord(value) ? value : {};
}

/** The source-mode `fireforge.json` document for the migrated project. */
function migratedConfig(
  document: JsonObject,
  queue: Queue,
  adopted: Adopted,
  pristine: { commit: string; directories: ReadonlySet<string> }
): JsonObject {
  const ownerOf = (path: string): string | undefined =>
    queue.patches.find((patch) => patch.files.includes(path))?.name;
  const createdOwners = new Map(
    adopted.created.flatMap((path) => {
      const owner = ownerOf(path);
      return owner === undefined ? [] : [[path, owner] as const];
    })
  );
  const tiers = new Map(
    queue.patches.flatMap((patch) =>
      patch.tier === undefined ? [] : [[patch.name, patch.tier] as const]
    )
  );
  const upstreamOwners = new Set(
    [...adopted.overridden, ...adopted.deleted].map((path) => ownerOf(path))
  );
  // A patch that changed upstream files and created others becomes two
  // groups, and two groups may not share an ID.
  const createdGroup = (patch: string): string =>
    upstreamOwners.has(patch) ? `${patch}-created` : patch;
  const groups = [...createdGlobs(createdOwners, pristine.directories)].map(([name, paths]) => ({
    name: createdGroup(name),
    paths,
    ...(tiers.has(name) ? { tier: tiers.get(name) } : {}),
  }));
  const componentTiers = Object.fromEntries(
    [...tiers].filter(([name]) => upstreamOwners.has(name))
  );
  const created = new Set(createdOwners.values());
  const waivers = queue.patches.flatMap((patch) =>
    [
      ...(upstreamOwners.has(patch.name) ? [patch.name] : []),
      ...(created.has(patch.name) ? [createdGroup(patch.name)] : []),
    ].flatMap((group) =>
      (patch.lintIgnore ?? []).map((entry) =>
        typeof entry === 'string'
          ? { group, rule: entry, reason: `Carried over from patch ${patch.name}` }
          : {
              group,
              rule: entry.rule,
              max: entry.max,
              reason: entry.reason,
              ...(entry.share === undefined ? {} : { share: entry.share }),
            }
      )
    )
  );
  const exportQueue = {
    ...section(document, 'exportQueue'),
    ...(groups.length === 0 ? {} : { groups }),
    ...(Object.keys(componentTiers).length === 0 ? {} : { componentTiers }),
  };
  const patchLint = {
    ...section(document, 'patchLint'),
    ...(waivers.length === 0 ? {} : { waivers }),
  };
  return {
    ...document,
    mode: 'source',
    source: { root: SOURCE_ROOT, metadataRoot: METADATA_ROOT, pristineCommit: pristine.commit },
    ...(Object.keys(exportQueue).length === 0 ? {} : { exportQueue }),
    ...(Object.keys(patchLint).length === 0 ? {} : { patchLint }),
  };
}

async function assertCommitted(project: Project): Promise<void> {
  const worktree = project.checkout.worktree;
  const refuse = (message: string): FireForgeError =>
    new FireForgeError('migrate-needs-clean-tree', message, {
      exitCode: ExitCode.GIT_ERROR,
      hint: 'Commit the project first: git is the undo of a migration.',
    });
  if (worktree === undefined) throw refuse('The project is not in a git repository.');
  const inside = toPosixPath(relative(worktree, project.root));
  const dirty = await gitStatus(worktree, inside === '' ? {} : { paths: [inside] });
  if (dirty.length > 0) {
    throw refuse(
      `The project has ${dirty.length} uncommitted change(s), such as ${dirty[0]?.path ?? ''}.`
    );
  }
}

/**
 * Converts a patch-mode project to source mode, in place, and proves the
 * result: the tree re-derived from the written owned files and records must
 * equal the tree the queue replays to. `patches/` is removed; `export`
 * writes it again as generated output.
 *
 * @param project - A committed patch-mode project whose pin has been downloaded
 * @throws `patch-mode-required`, `pristine-missing`, `queue-does-not-apply`,
 *   `migrate-needs-clean-tree`, `adopt-destination-not-empty`,
 *   `migrate-mismatch` (exit code 6) when the result does not reproduce the queue
 */
export async function migrate(project: Project): Promise<Migration> {
  const patches = requirePatchMode(project);
  const { root } = project;
  await assertCommitted(project);
  const pristine = await pinnedPristine(project);
  const queue = await readQueue(patches.paths.patches);
  const tree = await replayQueue(pristine.repo, pristine.commit, queue.dir);
  const { document, text } = await readConfigDocument(root);
  const configPath = join(root, CONFIG_FILE);
  let adopted: Adopted;
  let migrated: SourceProject;
  try {
    adopted = await adoptTrees(
      pristine,
      { repo: pristine.repo, tree },
      {
        destination: root,
        sourceRoot: SOURCE_ROOT,
        metadataRoot: METADATA_ROOT,
        ownerOf: (path) => ({
          component: defined(
            queue.patches.find((patch) => patch.files.includes(path))?.name,
            'a path the replay changed is in a patch'
          ),
        }),
      }
    );
    // Listing a directory's entries proves the directory and every ancestor of it.
    const upstream = await listTree(pristine.repo, pristine.commit, {
      paths: [...new Set(adopted.created.flatMap(ancestors))].map((directory) => `${directory}/`),
      recursive: false,
    });
    const config = migratedConfig(document, queue, adopted, {
      commit: pristine.commit,
      directories: new Set(upstream.flatMap((entry) => ancestors(entry.path))),
    });
    configSchema.parse(config, { source: configPath, code: 'config-invalid' });
    await writeFile(configPath, stringifyJson(config));
    migrated = requireSourceMode(await loadProject(root, { FIREFORGE_HOME: project.host.root }));
    const derived = await ownedTree(pristine, await sourceChanges(migrated, pristine));
    if (derived !== tree) {
      throw new FireForgeError(
        'migrate-mismatch',
        'The owned files and records written do not reproduce the tree the patch queue replays to.',
        { exitCode: ExitCode.PATCH_ERROR, hint: 'Nothing was kept. Report this.' }
      );
    }
  } catch (error: unknown) {
    // A source or metadata root that was refused as occupied holds nothing of ours to undo.
    const occupied =
      error instanceof FireForgeError && error.code === 'adopt-destination-not-empty';
    if (!occupied) {
      await remove(join(root, SOURCE_ROOT));
      await remove(join(root, METADATA_ROOT));
      await writeFile(configPath, text);
    }
    throw error;
  }
  await remove(patches.paths.patches);
  await installMergeDriver(migrated);
  return {
    created: [...adopted.created],
    overridden: [...adopted.overridden],
    deleted: [...adopted.deleted],
    pristineCommit: pristine.commit,
  };
}
