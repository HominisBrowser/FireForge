// SPDX-License-Identifier: EUPL-1.2
/**
 * Build-manifest and reference rules. Over the final state: moz.build lists
 * mozbuild keeps sorted, created modules a resource URL imports but no
 * moz.build installs, and manifest entries the owned changes add that name a
 * file nothing provides. Over the order of sequential groups (a patch
 * queue): an import or manifest entry that names a file only a later group
 * creates, unless the group declares that staged dependency.
 *
 * A staged dependency is declared in the group's meta as
 * `stagedDependencies: [{ file, creates }]`: `file` (in this group) may
 * reference `creates` (created by a later group).
 */
import { isRecord } from '../../kernel/json.js';
import { manifestKind, manifestReferences, mozBuildSortViolations } from '../../mozbuild/index.js';
import type { ChangeGroup, OwnedChange } from '../../project/index.js';
import { textContent } from '../../project/index.js';
import { importSpecifiers } from '../../syntax/index.js';
import { basename, type Draft, isJsFile, type Rule, type RuleContext } from '../rule.js';

const sortedLists: Rule = {
  id: 'mozbuild-unsorted-list',
  severity: 'error',
  description: 'Strict-ordered moz.build lists in owned files are sorted, as configure requires',
  check(context) {
    return context.owned.all().flatMap((file) =>
      manifestKind(file.path) !== 'moz-build' ||
      file.text === undefined ||
      !context.selected(file.path)
        ? []
        : mozBuildSortViolations(file.text).map((violation) => ({
            path: file.path,
            line: violation.line + 1,
            group: file.group,
            message:
              `moz.build list ${violation.variable} is not sorted: expected "${violation.expected}" ` +
              `but found "${violation.got}" (configure fails with UnsortedError).`,
          }))
    );
  },
};

/** The `/modules/…` install path a `resource:///modules/` or `resource://gre/modules/` URL names. */
function installedModulePath(specifier: string): string | undefined {
  const cleaned = specifier.split(/[?#]/)[0] ?? specifier;
  const match = /^resource:\/\/(?:\/|gre\/)modules\/(.+\.sys\.mjs)$/.exec(cleaned);
  return match?.[1] === undefined ? undefined : `/modules/${match[1]}`;
}

/** The text a change introduces: a created file whole, a modified file's added lines. */
async function introducedText(
  context: RuleContext,
  change: OwnedChange
): Promise<string | undefined> {
  if (change.kind === 'delete' || change.binary) return undefined;
  if (change.kind === 'create') return textContent(await change.after());
  const added = await context.owned.added(change);
  return added.map((entry) => entry.text).join('\n');
}

const unregisteredModule: Rule = {
  id: 'unregistered-system-module',
  severity: 'error',
  description:
    'A created module that owned code imports by resource URL is installed by a moz.build list',
  async check(context) {
    const imported = new Set<string>();
    for (const file of context.owned.all()) {
      if (!isJsFile(file.path)) continue;
      const text = await introducedText(context, file.change);
      for (const { specifier } of importSpecifiers(text ?? '')) {
        const installed = installedModulePath(specifier);
        if (installed !== undefined) imported.add(installed);
      }
    }
    const listed = context.owned
      .all()
      .filter((file) => manifestKind(file.path) === 'moz-build')
      .flatMap((file) => manifestReferences(file.path, file.text ?? ''));
    return context.owned.all().flatMap((file): Draft[] => {
      if (!file.created || !file.path.endsWith('.sys.mjs') || !context.selected(file.path))
        return [];
      if (![...imported].some((suffix) => file.path.endsWith(suffix))) return [];
      if (listed.some((reference) => reference.matcher.matches(file.path))) return [];
      const leaf = basename(file.path);
      return [
        {
          path: file.path,
          group: file.group,
          message:
            `The module is imported by resource URL, but no owned moz.build lists ${leaf}. Add it ` +
            'to EXTRA_JS_MODULES (or its namespaced list): source checks resolve the file, the ' +
            'packaged browser does not.',
        },
      ];
    });
  },
};

/** Reference kinds that name one file; support-files may name directories. */
const FILE_REFERENCES = new Set(['jar-source', 'test', 'head', 'tail']);

const danglingRegistration: Rule = {
  id: 'dangling-registration',
  severity: 'error',
  description: 'Manifest entries the owned changes add name files that exist',
  async check(context) {
    const drafts: Draft[] = [];
    for (const file of context.owned.all()) {
      if (manifestKind(file.path) === undefined || !context.selected(file.path)) continue;
      const added = file.created
        ? undefined
        : new Set((await context.owned.added(file.change)).map((entry) => entry.line));
      for (const reference of manifestReferences(file.path, file.text ?? '')) {
        const target = reference.matcher.exact;
        if (target === undefined || !FILE_REFERENCES.has(reference.kind)) continue;
        if (added !== undefined && !added.has(reference.line + 1)) continue;
        if (context.owned.get(target) !== undefined) continue;
        if (!context.owned.deletes(target) && (await context.engine.read(target)) !== undefined)
          continue;
        drafts.push({
          path: file.path,
          line: reference.line + 1,
          group: file.group,
          message: `"${reference.token}" names ${target}, which neither the owned changes nor the engine provide.`,
        });
      }
    }
    return drafts;
  },
};

interface StagedDependency {
  readonly file: string;
  readonly creates: string;
}

function stagedDependencies(group: ChangeGroup): StagedDependency[] {
  const declared = group.meta['stagedDependencies'];
  if (!Array.isArray(declared)) return [];
  return declared.flatMap((entry) =>
    isRecord(entry) && typeof entry['file'] === 'string' && typeof entry['creates'] === 'string'
      ? [{ file: entry['file'], creates: entry['creates'] }]
      : []
  );
}

/** One reference from a group's file to a path a later group creates. */
interface ForwardEdge {
  readonly kind: 'import' | 'registration';
  readonly group: string;
  readonly site: string;
  readonly line: number;
  readonly token: string;
  readonly creates: string;
  readonly creator: string;
}

const IMPORTABLE = /\.(?:m?js|jsm)$/;

/** Every forward edge of a sequential change set, in group order. */
function forwardEdges(context: RuleContext): Promise<ForwardEdge[]> {
  let edges = edgesByRun.get(context);
  if (edges === undefined) {
    edges = collectForwardEdges(context);
    edgesByRun.set(context, edges);
  }
  return edges;
}

/** The forward edges of each run, shared by the three rules that read them. */
const edgesByRun = new WeakMap<RuleContext, Promise<ForwardEdge[]>>();

async function collectForwardEdges(context: RuleContext): Promise<ForwardEdge[]> {
  const order = new Map(context.changes.groups.map((group, index) => [group.id, index]));
  const creations = context.changes.changes
    .filter((change) => change.kind === 'create' && change.group !== undefined)
    .map((change) => ({
      path: change.path,
      group: change.group ?? '',
      index: order.get(change.group ?? '') ?? 0,
    }));
  const edges: ForwardEdge[] = [];
  for (const [index, group] of context.changes.groups.entries()) {
    const later = creations.filter((creation) => creation.index > index);
    if (later.length === 0) continue;
    for (const step of context.changes.inGroup(group.id)) {
      const text = await introducedText(context, step);
      if (text === undefined) continue;
      const lineOf =
        step.kind === 'create' ? (line: number) => line : await addedLineMap(context, step);
      if (IMPORTABLE.test(step.path)) {
        for (const { specifier, line } of importSpecifiers(text)) {
          const leaf = basename(specifier.split(/[?#]/)[0] ?? specifier);
          if (!IMPORTABLE.test(leaf)) continue;
          for (const creation of later.filter((candidate) => basename(candidate.path) === leaf)) {
            edges.push({
              kind: 'import',
              group: group.id,
              site: step.path,
              line: lineOf(line),
              token: specifier,
              creates: creation.path,
              creator: creation.group,
            });
          }
        }
      }
      if (manifestKind(step.path) !== undefined) {
        for (const reference of manifestReferences(step.path, text)) {
          for (const creation of later.filter((candidate) =>
            reference.matcher.matches(candidate.path)
          )) {
            edges.push({
              kind: 'registration',
              group: group.id,
              site: step.path,
              line: lineOf(reference.line + 1),
              token: reference.token,
              creates: creation.path,
              creator: creation.group,
            });
          }
        }
      }
    }
  }
  return edges;
}

/** Maps a line of the joined added lines to its line in the step's result. */
async function addedLineMap(
  context: RuleContext,
  step: OwnedChange
): Promise<(line: number) => number> {
  const added = await context.owned.added(step);
  return (line) => added[line - 1]?.line ?? line;
}

function isDeclared(context: RuleContext, edge: ForwardEdge): boolean {
  const group = context.changes.group(edge.group);
  return (
    group !== undefined &&
    stagedDependencies(group).some((d) => d.file === edge.site && d.creates === edge.creates)
  );
}

function forwardRule(
  id: 'forward-import' | 'forward-registration',
  kind: ForwardEdge['kind']
): Rule {
  return {
    id,
    severity: 'error',
    description:
      kind === 'import'
        ? 'In sequential groups, no import names a module only a later group creates'
        : 'In sequential groups, no manifest entry names a file only a later group creates',
    async check(context) {
      if (!context.sequential) return [];
      return (await forwardEdges(context))
        .filter((edge) => edge.kind === kind && !isDeclared(context, edge))
        .map((edge) => ({
          path: edge.site,
          line: edge.line,
          group: edge.group,
          message:
            `"${edge.token}" names ${edge.creates}, which the later group ${edge.creator} creates, ` +
            'so the groups before it do not build alone. Reorder the groups, move the reference ' +
            `into ${edge.creator}, or declare the staged dependency { file: "${edge.site}", ` +
            `creates: "${edge.creates}" } on ${edge.group}.`,
        }));
    },
  };
}

const unusedStaged: Rule = {
  id: 'staged-dependency-unused',
  severity: 'warning',
  description: 'Every declared staged dependency matches a forward reference',
  async check(context) {
    if (!context.sequential) return [];
    const edges = await forwardEdges(context);
    return context.changes.groups.flatMap((group) =>
      stagedDependencies(group)
        .filter(
          (declared) =>
            !edges.some(
              (edge) =>
                edge.group === group.id &&
                edge.site === declared.file &&
                edge.creates === declared.creates
            )
        )
        .map((declared) => ({
          path: declared.file,
          group: group.id,
          message: `The staged dependency on ${declared.creates} matches no reference from ${declared.file} to a file a later group creates. Remove it.`,
        }))
    );
  },
};

/** The build-manifest and reference rules. */
export const registrationRules: readonly Rule[] = [
  sortedLists,
  unregisteredModule,
  danglingRegistration,
  forwardRule('forward-import', 'import'),
  forwardRule('forward-registration', 'registration'),
  unusedStaged,
];
