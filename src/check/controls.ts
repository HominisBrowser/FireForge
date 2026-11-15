// SPDX-License-Identifier: EUPL-1.2
/**
 * What a change leaves of the proof the verified commit holds, as far as
 * negative controls go, and which declared controls are owed a run.
 *
 * A control diff and the `gate.controls` declaration are inputs of the
 * controls and of nothing else the gate runs: a commit that changes only
 * those, and documents, leaves the product code, the lanes and every other
 * control as the verified commit proved them. {@link lightChange} says
 * whether a change is that small and which controls it makes run again.
 * {@link owedControls} reads the control record against the declarations and
 * the checkout, and names every control that has no standing proof, with the
 * reason. Both inform: nothing here fails a gate.
 */
import { posix as posixPath, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { GateConfig } from '../config/index.js';
import { changedPaths, readBlobs } from '../git/index.js';
import { readBytesIfExists, toPosixPath } from '../kernel/fs.js';
import { matchesAnyGlob } from '../kernel/glob.js';
import { hash } from '../kernel/hash.js';
import { isRecord, parseJson } from '../kernel/json.js';
import type { Project } from '../project/index.js';
import { type ControlRun, readControlRuns } from '../test/index.js';

type Control = NonNullable<GateConfig['controls']>[number];

/** Why a declared control has no standing proof. */
export type OwedReason =
  'never-run' | 'changed' | 'tree-changed' | 'missed' | 'wrong-red' | 'not-caught';

/** A declared control that is owed a run. */
export interface OwedControl {
  id: string;
  reason: OwedReason;
  /** One sentence for a person. */
  detail: string;
}

/** A change that leaves the verified proof standing but for some controls. */
export interface LightChange {
  /** Declared controls whose diff or declaration changed: they run again. */
  rerun: string[];
  /** Every changed path is one `gate.documents` covers. */
  documentsOnly: boolean;
}

const posix = (path: string): string => toPosixPath(path).replace(/^\.\//, '');

/** The raw `fireforge.json` at a revision, split into `gate.controls` and the rest. */
async function rawConfigAt(
  project: Project,
  revision: string
): Promise<{ rest: unknown; controls: Map<string, unknown> } | undefined> {
  const spec = `${revision}:${posix(relative(project.root, project.paths.config))}`;
  const text = (await readBlobs(project.root, [spec])).get(spec)?.toString('utf8');
  if (text === undefined) return undefined;
  let document;
  try {
    document = parseJson(text, { source: spec });
  } catch {
    return undefined;
  }
  if (!isRecord(document)) return undefined;
  const { gate, ...others } = document;
  const { controls, ...gateRest } = isRecord(gate) ? gate : ({} as Record<string, unknown>);
  const entries = Array.isArray(controls) ? controls : [];
  const byId = new Map<string, unknown>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry['id'] === 'string') byId.set(entry['id'], entry);
  }
  return { rest: { ...others, gate: gateRest }, controls: byId };
}

/**
 * Whether a control diff at `path` could reach what the gate builds or runs
 * besides the controls: a file under the source root, the components, the
 * patch queue or the mozconfig fragments is read by the build, and a path
 * another declared entry names is read by that entry.
 */
function readByTheBuild(project: Project, path: string): boolean {
  const roots = [
    relative(project.root, project.paths.components),
    relative(project.root, project.paths.patches),
    relative(project.root, project.paths.configs),
    ...(project.mode === 'source'
      ? [project.config.source.root, relative(project.root, project.paths.sourceMetadata)]
      : ['engine']),
  ].map((root) => posix(root).replace(/\/$/, ''));
  if (roots.some((root) => root !== '' && (path === root || path.startsWith(`${root}/`)))) {
    return true;
  }
  const gate = project.config.gate;
  return stringsOf([gate?.lanes, gate?.stress, gate?.runs]).some((text) => names(text, path));
}

/** Every string anywhere inside a declaration. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  return isRecord(value) ? Object.values(value).flatMap(stringsOf) : [];
}

/**
 * Whether a declared string could name `path`: the path itself however it is
 * spelled (`a//b`, `./a/b`, backslashes), inside a longer argument, a
 * directory above it, or a glob that matches it.
 */
function names(text: string, path: string): boolean {
  const spelled = posixPath.normalize(text.replaceAll('\\', '/')).replace(/^\.\//, '');
  const directory = spelled.replace(/\/$/, '');
  return (
    spelled.includes(path) ||
    (directory !== '' && directory !== '.' && path.startsWith(`${directory}/`)) ||
    matchesAnyGlob(path, [spelled], { basename: true })
  );
}

/**
 * Whether a change from `from` to `to` (commits or trees) is one the proof of
 * `from` survives: every changed path is a document, the diff file of a
 * declared control that nothing builds, or `fireforge.json` differing only
 * inside `gate.controls`.
 *
 * @param project - The project, whose declarations are those of `to`
 * @param from - The revision whose proof is carried
 * @param to - The revision being judged
 * @returns Undefined when anything else changed; otherwise the controls to run again
 */
export async function lightChange(
  project: Project,
  from: string,
  to: string
): Promise<LightChange | undefined> {
  const changed = (await changedPaths(project.root, from, to)).map(posix);
  const gate = project.config.gate;
  const documents = gate?.documents ?? [];
  const declared = gate?.controls ?? [];
  const configPath = posix(relative(project.root, project.paths.config));
  const configChanged = changed.includes(configPath);
  const before = configChanged ? await rawConfigAt(project, from) : undefined;
  const after = configChanged ? await rawConfigAt(project, to) : undefined;
  if (configChanged) {
    if (
      before === undefined ||
      after === undefined ||
      !isDeepStrictEqual(before.rest, after.rest)
    ) {
      return undefined;
    }
  }
  const diffs = new Set([
    ...declared.map((control) => posix(control.diff)),
    ...[...(before?.controls.values() ?? [])].flatMap((entry) =>
      isRecord(entry) && typeof entry['diff'] === 'string' ? [posix(entry['diff'])] : []
    ),
  ]);
  for (const path of changed) {
    if (diffs.has(path)) {
      if (readByTheBuild(project, path)) return undefined;
    } else if (path !== configPath && !matchesAnyGlob(path, documents, { basename: true })) {
      return undefined;
    }
  }
  const rerun = declared
    .filter(
      (control) =>
        changed.includes(posix(control.diff)) ||
        (configChanged &&
          !isDeepStrictEqual(before?.controls.get(control.id), after?.controls.get(control.id)))
    )
    .map((control) => control.id);
  const documentsOnly = changed.every(
    (path) =>
      !diffs.has(path) && path !== configPath && matchesAnyGlob(path, documents, { basename: true })
  );
  return { rerun, documentsOnly };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/** Whether a recorded run is of the control as declared now: same tests and same expected labels. */
const sameDeclaration = (run: ControlRun, control: Control): boolean =>
  run.diff.path === posix(control.diff) &&
  sameSet(run.tests, [control.test]) &&
  sameSet(run.expect, control.assertions);

/** The runs that count for a declared control: its ID's, or an ad hoc run of exactly its declaration. */
const runsOf = (runs: readonly ControlRun[], control: Control): ControlRun[] =>
  runs.filter(
    (run) => run.id === control.id || (run.id === undefined && sameDeclaration(run, control))
  );

const quoted = (labels: readonly string[]): string =>
  labels.map((label) => JSON.stringify(label)).join(', ');

/**
 * The declared controls that are owed a run, each with why: never run; the
 * diff or the declaration changed since the last run; the tree changed since
 * the last run caught; or the last run stayed green, went red beyond the
 * expected assertions, or was otherwise not caught.
 *
 * @param project - The project
 * @param head - The checked-out commit's tree, when the working tree equals it; without it a control is not owed for a changed tree
 */
export async function owedControls(
  project: Project,
  head?: { tree: string }
): Promise<OwedControl[]> {
  const declared = project.config.gate?.controls ?? [];
  if (declared.length === 0) return [];
  const runs = await readControlRuns(project);
  const owed: OwedControl[] = [];
  for (const control of declared) {
    const last = runsOf(runs, control).at(-1);
    const found = (reason: OwedReason, detail: string): void => {
      owed.push({ id: control.id, reason, detail });
    };
    if (last === undefined) {
      found('never-run', 'it has not run in this checkout');
      continue;
    }
    const bytes = await readBytesIfExists(`${project.root}/${control.diff}`);
    const identity = bytes === undefined ? '' : hash(bytes);
    if (identity !== last.diff.hash || !sameDeclaration(last, control)) {
      const what =
        identity !== last.diff.hash ? 'its diff' : 'its declaration (tests or assertions)';
      found('changed', `${what} changed since it last ran`);
    } else if (last.outcome === 'missed') {
      found('missed', 'the last run stayed green with the mutation applied');
    } else if (last.outcome === 'wrong-red') {
      found(
        'wrong-red',
        last.unexpected.length > 0
          ? `the last run was red beyond the expected assertions: ${quoted(last.unexpected)}`
          : `the last run was not red at exactly the expected assertions${last.why === undefined ? '' : ` (${last.why})`}`
      );
    } else if (last.outcome !== 'caught') {
      found('not-caught', `the last run ended ${last.outcome}`);
    } else if (head !== undefined && last.against.tree !== head.tree) {
      const light =
        last.against.tree === undefined
          ? undefined
          : await lightChange(project, last.against.tree, head.tree).catch(() => undefined);
      if (light === undefined || light.rerun.includes(control.id)) {
        found(
          'tree-changed',
          last.against.tree === undefined
            ? 'it was last caught on a tree that was not committed'
            : 'the tree changed since it was last seen caught'
        );
      }
    }
  }
  return owed;
}
