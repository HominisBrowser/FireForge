// SPDX-License-Identifier: EUPL-1.2
/**
 * The owned changes as an ordered patch queue, for whatever consumes one: a
 * public export whose CI runs `fireforge import`, or a move back to patch
 * mode. This plans the queue; writing its manifest and proving that it
 * replays belong to the patch queue's own module.
 *
 * Each path is in exactly one patch, so no patch depends on another's
 * context, and the patches are the groups of `groups.ts`, each named after
 * its group's ID. The plan is a
 * function of the owned files and the pin: planning twice gives the same
 * bytes, and an edit to one file changes only that file's patch and the
 * manifest source.
 */
import { defined, ExitCode, FireForgeError } from '../kernel/errors.js';
import { hash } from '../kernel/hash.js';
import type { SourceProject } from '../project/index.js';
import { exportedPatchName, planGroups } from './groups.js';
import { diffSections, writeDeltaTrees } from './objects.js';
import type { Pristine } from './records.js';
import { readSourceTree } from './tree.js';

/** One patch of the planned queue. */
export interface QueuePatch {
  /** The ID of the group it holds. */
  readonly group: string;
  /** Its name in the queue, unique among the planned patches. */
  readonly name: string;
  readonly description: string;
  /** The engine paths it changes, in the order the body holds them. */
  readonly files: readonly string[];
  /** The patch bytes, in the pinned diff format. */
  readonly body: Buffer;
}

/** A planned queue. */
export interface QueueExportPlan {
  /** In application order. */
  readonly patches: readonly QueuePatch[];
  /**
   * What the queue was generated from, for the manifest's `source`: the
   * pristine commit and a digest of the upstream and owned sides of every
   * owned path. Two checkouts with the same owned content give the same.
   */
  readonly manifestSource: { readonly pristineCommit: string; readonly digest: string };
}

/**
 * Plans the patch queue the checkout's owned changes export as.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @throws `source-invalid` (exit code 2) while `verify` reports any problem;
 *   `source-group-name-collision` when two groups would share an ID or two
 *   patches a name, `source-group-unexportable` for an ID no patch can be named after
 */
export async function planQueueExport(
  project: SourceProject,
  pristine: Pristine
): Promise<QueueExportPlan> {
  const tree = await readSourceTree(project, pristine);
  if (tree.problems.length > 0) {
    throw new FireForgeError(
      'source-invalid',
      `The owned files cannot be exported until these are fixed:\n${tree.problems
        .map((problem) => `  ${problem.path}: ${problem.message}`)
        .join('\n')}`,
      { exitCode: ExitCode.CONFIG_ERROR, hint: 'Run "fireforge verify" for what to do.' }
    );
  }
  const groups = planGroups(tree.entries, project.config.exportQueue);
  const trees = await writeDeltaTrees(tree, tree.entries);
  const sections = await diffSections(trees);
  const patches: QueuePatch[] = [];
  const named = new Map<string, string>();
  for (const group of groups) {
    const members = new Set(group.paths);
    const files = [...sections.keys()].filter((path) => members.has(path));
    if (files.length === 0) continue;
    const name = exportedPatchName(group.id);
    const other = named.get(name);
    if (other !== undefined) {
      throw new FireForgeError(
        'source-group-name-collision',
        `Groups "${other}" and "${group.id}" would both export as patch "${name}".`,
        {
          exitCode: ExitCode.CONFIG_ERROR,
          hint: 'Rename a component in its override records, or an exportQueue group.',
        }
      );
    }
    named.set(name, group.id);
    patches.push({
      group: group.id,
      name,
      description: group.description,
      files,
      body: Buffer.concat(
        files.map((path) =>
          defined(sections.get(path), () => `the diff holds a section for ${path}`)
        )
      ),
    });
  }
  return {
    patches,
    manifestSource: {
      pristineCommit: pristine.commit,
      digest: hash(`${pristine.commit}\n${trees.before}\n${trees.after}\n`),
    },
  };
}
