// SPDX-License-Identifier: EUPL-1.2
/**
 * Lets `export --order` land a new system module whose moz.build line is
 * still unexported working-tree drift in the patch that registers it.
 *
 * The two refusals used to deadlock: the module's export failed
 * `unregistered-system-module` because no patch body carried its moz.build
 * line yet, and the registering patch could not be re-exported first
 * because its line named a file no patch created. The way through is
 * declared intent plus evidence: when the registering patch carries a
 * staged registration for the module and the working tree's moz.build has
 * exactly that line, the export is accepted and the operator is told to
 * re-export the registering patch next. Without the declaration the
 * refusal names the steps, with the exact `patch staged-dependency`
 * command, instead of stopping at "register it".
 *
 * Consumed by export-flow.ts.
 */

import { basename, dirname, join } from 'node:path';

import type { PatchQueueContext } from '../core/patch-lint.js';
import { STAGED_DEPENDENCY_REASON_PLACEHOLDER } from '../core/patch-lint-staged-registration.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import { pathExists, readText } from '../utils/fs.js';

/** Result of {@link acceptTreeRegisteredModules}. */
export interface TreeRegistrationOutcome {
  /** The projected errors left after accepted modules are removed. */
  remaining: PatchLintIssue[];
  /** One note per accepted module, naming the re-export to run next. */
  accepted: string[];
  /** Detail lines for modules whose registration is in the tree but undeclared. */
  advice: string[];
}

async function readLines(path: string): Promise<string[] | undefined> {
  if (!(await pathExists(path))) return undefined;
  return (await readText(path)).split('\n').map((line) => line.trim());
}

/** The nearest moz.build at or above `modulePath` whose lines name `leaf` quoted. */
async function findTreeRegistration(
  engineDir: string,
  modulePath: string
): Promise<{ file: string; line: string } | undefined> {
  const leaf = basename(modulePath);
  let dir = dirname(modulePath);
  for (;;) {
    const file = dir === '.' ? 'moz.build' : `${dir}/moz.build`;
    const line = (await readLines(join(engineDir, file)))?.find(
      (candidate) => candidate.includes(`"${leaf}"`) || candidate.includes(`'${leaf}'`)
    );
    if (line !== undefined) return { file, line };
    if (dir === '.' || dir === '') return undefined;
    const parent = dirname(dir);
    dir = parent === dir ? '.' : parent;
  }
}

/**
 * Removes `unregistered-system-module` findings for modules the pending
 * export creates when a queue patch declares their registration as a
 * staged dependency and the working tree's moz.build carries that line.
 * For a module whose line is in the tree but undeclared, returns the steps
 * that make it acceptable.
 *
 * @param args - The engine directory (the working tree), the current queue,
 *   the filename the pending export would take, the files it creates, and
 *   the placement projection's error findings
 */
export async function acceptTreeRegisteredModules(args: {
  engineDir: string;
  baseCtx: PatchQueueContext;
  newFilename: string;
  pendingNewFiles: ReadonlySet<string>;
  projectedIssues: readonly PatchLintIssue[];
}): Promise<TreeRegistrationOutcome> {
  const outcome: TreeRegistrationOutcome = { remaining: [], accepted: [], advice: [] };
  for (const issue of args.projectedIssues) {
    if (issue.check !== 'unregistered-system-module' || !args.pendingNewFiles.has(issue.file)) {
      outcome.remaining.push(issue);
      continue;
    }
    const declared = args.baseCtx.entries.flatMap((entry) =>
      (entry.metadata?.stagedDependencies?.registrations ?? [])
        .filter(
          (registration) =>
            registration.creates === issue.file &&
            (registration.owner === undefined || registration.owner === args.newFilename)
        )
        .map((registration) => ({ holder: entry.filename, registration }))
    );
    let accepted = false;
    for (const { holder, registration } of declared) {
      const lines = await readLines(join(args.engineDir, registration.file));
      if (lines?.includes(registration.line.trim()) !== true) continue;
      outcome.accepted.push(
        `${issue.file} is registered by the working tree's ${registration.file} ` +
          `("${registration.line.trim()}"), which ${holder} declares as a staged registration ` +
          `but has not exported yet. Re-export ${holder} right after this export to land the ` +
          `line: fireforge re-export ${holder}`
      );
      accepted = true;
      break;
    }
    if (accepted) continue;
    outcome.remaining.push(issue);

    const tree = await findTreeRegistration(args.engineDir, issue.file);
    if (tree === undefined) continue;
    const owner = args.baseCtx.entries.find((entry) =>
      entry.metadata?.filesAffected.includes(tree.file)
    )?.filename;
    if (owner === undefined) continue;
    outcome.advice.push(
      '',
      `${issue.file} is registered in the working tree's ${tree.file}, but ${owner} has not ` +
        'exported that line. Land both without untangling the tree:',
      `  1. fireforge patch staged-dependency ${owner} --add --kind registration --file ${tree.file} ` +
        `--line "${tree.line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" --creates ${issue.file} ` +
        `--owner ${args.newFilename} ${STAGED_DEPENDENCY_REASON_PLACEHOLDER}`,
      '  2. re-run this export (a declared registration present in the working tree is accepted)',
      `  3. fireforge re-export ${owner}`
    );
  }
  return outcome;
}
