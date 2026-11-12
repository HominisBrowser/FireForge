// SPDX-License-Identifier: EUPL-1.2
/**
 * Bringing a project written by the previous FireForge to the current
 * format, in place. Each owning module knows its own previous format
 * (`config/previous.ts`, `source/previous.ts`); this file decides the order,
 * carries what one conversion tells another, and makes the whole change one
 * journaled transaction on a committed tree, so a failure leaves the project
 * as it was and `git` undoes a success.
 *
 * Nothing is guessed. A key or file that cannot be converted without a
 * decision stops the upgrade before anything is written, named with what to
 * do; everything rewritten or dropped is reported. A project already in the
 * current format is left untouched.
 */
import { join, relative } from 'node:path';

import {
  CONFIG_FILE,
  type ConfigUpgrade,
  readConfigDocument,
  upgradeConfig,
  type UpgradeNote,
} from '../config/index.js';
import { withoutObjdir } from '../engine/index.js';
import { getConfig, status as gitStatus } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import {
  exists,
  listDir,
  readText,
  readTextIfExists,
  toPosixPath,
  walkFiles,
} from '../kernel/fs.js';
import { transaction } from '../kernel/journal.js';
import {
  isRecord,
  type JsonObject,
  type JsonValue,
  omitKeys,
  stringifyJson,
} from '../kernel/json.js';
import { editJsonText } from '../kernel/json-edit.js';
import {
  type Environment,
  findProjectRoot,
  loadProject,
  type Project,
  projectPaths,
  readCheckout,
} from '../project/index.js';
import {
  installMergeDriver,
  parsePreviousWaivers,
  parseScopeDecisions,
  PREVIOUS_MERGE_DRIVER,
  PREVIOUS_METADATA_FILES,
  type PreviousWaiver,
  requireSourceMode,
  sourceStatus,
  upgradeAttributes,
  upgradeRecord,
} from '../source/index.js';
import { componentGroups } from './changes.js';
import { placeWaivers, withWaivers } from './previousWaivers.js';
import { download } from './pristine.js';
import { verify, type VerifyReport } from './report.js';

/** What {@link upgrade} did. */
export type Upgrade = {
  /** `current`: the project was already in the current format and nothing was written. */
  state: 'current' | 'upgraded';
  mode: 'patches' | 'source';
  /** Keys and metadata rewritten to their current form. */
  converted: UpgradeNote[];
  /** Keys and metadata dropped, each with what takes its place. */
  removed: UpgradeNote[];
  /** Project-relative files rewritten, `fireforge.json` among them. */
  rewritten: string[];
  /** Project-relative files deleted because nothing reads them. */
  deleted: string[];
  /** What was not carried over because only a person can decide it, each with the choice. */
  manual: UpgradeNote[];
  /** What is left for a person outside the project, such as git configuration shared with other checkouts. */
  followUp: string[];
  /** The integrity of the project's storage after the upgrade. */
  verify: VerifyReport;
};

/** A file the upgrade writes (`content`) or deletes (`content` undefined), project-relative. */
type FileChange = { path: string; content?: string };

type Plan = {
  config: ConfigUpgrade;
  document: JsonObject;
  mode: 'patches' | 'source';
  files: FileChange[];
  converted: UpgradeNote[];
  removed: UpgradeNote[];
  blockers: UpgradeNote[];
  waivers: PreviousWaiver[];
};

function section(document: JsonObject, key: string): JsonObject {
  const value = document[key];
  return isRecord(value) ? value : {};
}

/** Drops the scope rules a reviewed `policy.json` retired; a retained one needs a person. */
async function applyScopeDecisions(plan: Plan, root: string, previous: JsonObject): Promise<void> {
  const metadataRoot = section(plan.document, 'source')['metadataRoot'];
  const policy = section(plan.document, 'patchPolicy');
  const rules = section(previous, 'patchPolicy')['scopeRules'];
  if (typeof metadataRoot !== 'string' || !Array.isArray(rules) || rules.length === 0) return;
  const file = join(root, metadataRoot, 'policy.json');
  const text = await readTextIfExists(file);
  if (text === undefined || !Array.isArray(policy['scopeRules'])) return;
  const decisions = parseScopeDecisions(text, file, rules);
  const kept: JsonValue[] = [];
  for (const [index, rule] of policy['scopeRules'].entries()) {
    const decision = decisions[index];
    const key = `patchPolicy.scopeRules[${index}]`;
    if (decision?.decision === 'retire') {
      plan.removed.push({
        key,
        message: `was retired by ${metadataRoot}/policy.json: ${decision.reason}`,
      });
    } else if (decision?.decision === 'retain') {
      plan.blockers.push({
        key,
        message:
          `was retained by ${metadataRoot}/policy.json as a scope over paths, which a scope over groups cannot express. ` +
          'Remove the rule, or rewrite it with a "group" expression, then run migrate again',
      });
      kept.push(rule);
    } else {
      kept.push(rule);
    }
  }
  plan.document = {
    ...plan.document,
    patchPolicy:
      kept.length === 0 ? omitKeys(policy, 'scopeRules') : { ...policy, scopeRules: kept },
  };
}

/** The file changes a source-mode project's metadata needs. */
async function planSource(plan: Plan, root: string): Promise<void> {
  const source = section(plan.document, 'source');
  const [sourceRoot, metadataRoot] = [source['root'], source['metadataRoot']];
  if (typeof sourceRoot !== 'string' || typeof metadataRoot !== 'string') return;
  const overrides = join(root, metadataRoot, 'overrides');
  let records = 0;
  for (const file of await walkFiles(overrides)) {
    if (!file.endsWith('.json')) continue;
    const path = `${metadataRoot}/overrides/${file}`;
    const result = upgradeRecord(
      await readText(join(overrides, file)),
      file.slice(0, -'.json'.length)
    );
    if (result.state === 'invalid') plan.blockers.push({ key: path, message: result.problem });
    if (result.state === 'converted') {
      plan.files.push({ path, content: result.text });
      records += 1;
    }
  }
  if (records > 0) {
    plan.converted.push({
      key: `${metadataRoot}/overrides`,
      message: `${records} override record(s) rewritten without schemaVersion, path and base.pin`,
    });
  }
  const attributes = `${sourceRoot}/.gitattributes`;
  const text = await readTextIfExists(join(root, attributes));
  const next = text === undefined ? undefined : upgradeAttributes(text);
  if (next !== undefined) {
    plan.files.push({ path: attributes, content: next });
    plan.converted.push({ key: attributes, message: `names the merge driver "fireforge"` });
  }
  const waivers = join(root, metadataRoot, 'waivers.json');
  const waiverText = await readTextIfExists(waivers);
  if (waiverText !== undefined) plan.waivers = parsePreviousWaivers(waiverText, waivers);
  for (const name of PREVIOUS_METADATA_FILES) {
    if (!(await exists(join(root, metadataRoot, name)))) continue;
    plan.files.push({ path: `${metadataRoot}/${name}` });
    plan.removed.push({
      key: `${metadataRoot}/${name}`,
      message:
        name === 'waivers.json'
          ? 'its waivers are now patchLint.waivers and exportQueue.componentTiers'
          : name === 'policy.json'
            ? 'its scope decisions are applied to patchPolicy.scopeRules; groups of created files are judged file by file, not by size'
            : 'nothing reads it',
    });
  }
}

/** Everything the upgrade would change, read without writing. */
async function planUpgrade(root: string): Promise<Plan> {
  const { document: previous } = await readConfigDocument(root);
  const config = upgradeConfig(previous);
  const plan: Plan = {
    config,
    document: config.document,
    mode: config.document['mode'] === 'source' ? 'source' : 'patches',
    files: [],
    converted: [...config.converted],
    removed: [...config.removed],
    blockers: [...config.blockers],
    waivers: [],
  };
  if (plan.blockers.length > 0) return plan;
  if (plan.mode === 'source') {
    await applyScopeDecisions(plan, root, previous);
    await planSource(plan, root);
  }
  const { configs } = projectPaths(root);
  for (const entry of await listDir(configs)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.mozconfig')) continue;
    const next = withoutObjdir(await readText(join(configs, entry.name)));
    if (next === undefined) continue;
    plan.files.push({ path: `configs/${entry.name}`, content: next });
    plan.removed.push({
      key: `configs/${entry.name}`,
      message: 'its MOZ_OBJDIR declaration: FireForge places the object directory itself',
    });
  }
  const fragment = 'fireforge.fragment.json';
  if (await exists(join(root, fragment))) {
    plan.files.push({ path: fragment });
    plan.removed.push({ key: fragment, message: 'nothing reads it' });
  }
  return plan;
}

function blocked(blockers: readonly UpgradeNote[]): FireForgeError {
  const lines = blockers.map((note) => `  ${note.key}: ${note.message}`);
  return new FireForgeError(
    'migrate-blocked',
    `${blockers.length} thing(s) cannot be converted without a decision:\n${lines.join('\n')}`,
    {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Nothing was written. Change each one as its line says, commit, and run "fireforge migrate" again.',
    }
  );
}

async function assertCommitted(root: string): Promise<void> {
  const { worktree } = await readCheckout(root);
  const refuse = (message: string): FireForgeError =>
    new FireForgeError('migrate-needs-clean-tree', message, {
      exitCode: ExitCode.GIT_ERROR,
      hint: 'Commit the project first: git is the undo of a migration.',
    });
  if (worktree === undefined) throw refuse('The project is not in a git repository.');
  const inside = toPosixPath(relative(worktree, root));
  const dirty = await gitStatus(worktree, inside === '' ? {} : { paths: [inside] });
  if (dirty.length > 0) {
    throw refuse(
      `The project has ${dirty.length} uncommitted change(s), such as ${dirty[0]?.path ?? ''}.`
    );
  }
}

/** What {@link upgrade} can be told. */
export interface UpgradeOptions {
  /** Receives one line per phase of a download the upgrade needs. */
  onProgress?: (message: string) => void;
}

/**
 * Upgrades the project at or above `cwd` from the previous format, in
 * place, and checks the result with `verify`.
 *
 * @param cwd - Where the command was run
 * @param env - The environment of the invocation
 * @param options - See {@link UpgradeOptions}
 * @throws `migrate-blocked` (exit code 2) naming everything that needs a
 *   decision, `migrate-needs-clean-tree` (exit code 4), and, for a
 *   source-mode project whose pin this host lacks, what `download` throws
 */
export async function upgrade(
  cwd: string,
  env: Environment,
  options: UpgradeOptions = {}
): Promise<Upgrade> {
  const root = await findProjectRoot(cwd);
  const plan = await planUpgrade(root);
  if (plan.blockers.length > 0) throw blocked(plan.blockers);
  const pending = plan.converted.length + plan.removed.length + plan.files.length > 0;
  if (!pending) {
    const project = await loadProject(root, env);
    return {
      state: 'current',
      mode: project.mode,
      converted: [],
      removed: [],
      rewritten: [],
      deleted: [],
      manual: [],
      followUp: [],
      verify: await verify(project),
    };
  }
  await assertCommitted(root);
  const configPath = join(root, CONFIG_FILE);
  const configText = await readText(configPath);
  const render = (document: JsonObject): string =>
    editJsonText(configText, document) ?? stringifyJson(document);
  const { converted, removed } = plan;
  const manual: UpgradeNote[] = [...plan.config.manual];

  const project = await transaction(
    join(projectPaths(root).stateDir, 'migrate.journal'),
    'the format upgrade',
    async (tx): Promise<Project> => {
      await tx.write(configPath, render(plan.document));
      for (const file of plan.files) {
        if (file.content === undefined) await tx.remove(join(root, file.path));
        else await tx.write(join(root, file.path), file.content);
      }
      const loaded = await loadProject(root, env);
      if (loaded.mode !== 'source') return loaded;
      // The pin's pristine repository is what the waivers' groups and the closing verify are read against.
      const { pristine } = await download(loaded, options);
      if (plan.waivers.length === 0) return loaded;
      const declared = new Set((loaded.config.exportQueue.groups ?? []).map((group) => group.name));
      const waivers = placeWaivers(
        plan.waivers,
        await sourceStatus(loaded, pristine),
        declared,
        await componentGroups(loaded)
      );
      if (waivers.blockers.length > 0) throw blocked(waivers.blockers);
      converted.push(...waivers.converted, {
        key: 'waivers.json',
        message: `${waivers.waivers.length} waiver(s) are now patchLint.waivers`,
      });
      removed.push(...waivers.removed);
      manual.push(...waivers.manual);
      await tx.write(configPath, render(withWaivers(plan.document, waivers)));
      const final = await loadProject(root, env);
      const regrouped = await sourceStatus(requireSourceMode(final), pristine);
      for (const group of waivers.groups) {
        const held = regrouped.owned.filter((entry) => entry.group === group.name);
        if (held.length !== group.paths.length) {
          throw new FireForgeError(
            'migrate-mismatch',
            `Group "${group.name}" would hold ${held.length} file(s), not the ${group.paths.length} its waiver covered.`,
            { exitCode: ExitCode.CONFIG_ERROR, hint: 'Nothing was kept. Report this.' }
          );
        }
      }
      return final;
    }
  );

  const followUp: string[] = [];
  if (project.mode === 'source') {
    await installMergeDriver(project);
    const worktree = project.checkout.worktree ?? root;
    if ((await getConfig(worktree, `merge.${PREVIOUS_MERGE_DRIVER}.driver`)) !== undefined) {
      followUp.push(
        `The repository's git configuration still declares the merge driver "${PREVIOUS_MERGE_DRIVER}", which checkouts ` +
          `not yet upgraded use. Once none is left: git config --remove-section merge.${PREVIOUS_MERGE_DRIVER}`
      );
    }
  }
  return {
    state: 'upgraded',
    mode: project.mode,
    converted,
    removed,
    manual,
    rewritten: [
      CONFIG_FILE,
      ...plan.files.flatMap((file) => (file.content === undefined ? [] : [file.path])),
    ],
    deleted: plan.files.flatMap((file) => (file.content === undefined ? [file.path] : [])),
    followUp,
    verify: await verify(project),
  };
}
