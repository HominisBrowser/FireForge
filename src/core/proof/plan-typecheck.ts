// SPDX-License-Identifier: EUPL-1.2
/**
 * Which `typecheck.projects` a task's change reaches, so a task types them the
 * way the gate's check does instead of leaving a project-pass red to the gate.
 */
import { posix } from 'node:path';

import { parse } from 'jsonc-parser';

import type { TypecheckConfig } from '../../types/config.js';
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { readSourceBlobs } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import type { JobStep } from '../jobs/schema.js';
import { stepFingerprint } from './plan-steps.js';
import type { ChangedPath, Obligation } from './types.js';

/** One configured project, with the membership patterns its jsconfig states. */
export interface TypecheckProjectScope {
  /** The jsconfig as `typecheck.projects` names it, relative to the project root. */
  project: string;
  /** Its `files`, `include` and `exclude`; all absent when the capture does not hold it. */
  files?: string[];
  include?: string[];
  exclude?: string[];
}

/** The project pass a task can predict: every configured project and the shims they all read. */
export interface PlanTypecheck {
  projects: TypecheckProjectScope[];
  /** Project-relative shim paths: a change to one re-types every project. */
  shims: string[];
}

/** What the project pass reads as a root under `allowJs`. */
const TYPED_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** TypeScript's own `exclude` when a jsconfig states none. */
const DEFAULT_EXCLUDE = ['node_modules', 'bower_components', 'jspm_packages'];

/** Every project typed, which serves any subset of them. */
const everyProject = (): JobStep => ({ command: 'typecheck', args: [] });

const normalize = (path: string): string => posix.normalize(path).replace(/^\.\//, '');

/** A change by its project-relative path, where `typecheck.projects` names jsconfigs. */
const projectPath = (change: ChangedPath): string =>
  change.tree === 'engine' ? `engine/${change.path}` : change.path;

/**
 * A pattern relative to the jsconfig's directory, as TypeScript reads it: a last
 * segment with neither a wildcard nor an extension names a directory.
 */
function patternsOf(directory: string, pattern: string): string[] {
  const full = normalize(posix.join(directory, pattern));
  const last = full.split('/').at(-1) ?? '';
  return /[*?]/.test(last) || last.includes('.') ? [full] : [`${full}/**/*`];
}

/** Whether a project-relative path is a root of the project, by its jsconfig's patterns. */
export function inTypecheckProject(scope: TypecheckProjectScope, path: string): boolean {
  if (!TYPED_FILE.test(path)) return false;
  const directory = posix.dirname(normalize(scope.project));
  if ((scope.files ?? []).some((file) => normalize(posix.join(directory, file)) === path))
    return true;
  const include = scope.include ?? (scope.files === undefined ? ['**/*'] : []);
  if (
    !matchesAnyGlob(
      path,
      include.flatMap((pattern) => patternsOf(directory, pattern))
    )
  )
    return false;
  const exclude = (scope.exclude ?? DEFAULT_EXCLUDE).flatMap((pattern) => {
    const full = normalize(posix.join(directory, pattern));
    return [full, `${full}/**/*`];
  });
  return !matchesAnyGlob(path, exclude);
}

/**
 * The step typing what a task changed: every project after a structural change or
 * a change to a shim or jsconfig, otherwise the projects holding a changed file.
 * A deleted file counts, since what imported it no longer resolves. Undefined when
 * the change reaches no project.
 */
function typecheckStep(
  changed: readonly ChangedPath[],
  typecheck: PlanTypecheck,
  structural: boolean
): JobStep | undefined {
  const projects = typecheck.projects.map((scope) => normalize(scope.project));
  const paths = changed.map(projectPath);
  const shared = new Set([...typecheck.shims.map(normalize), ...projects]);
  if (projects.length === 0) return undefined;
  if (structural || paths.some((path) => shared.has(path))) return everyProject();
  const reached = typecheck.projects
    .filter((scope) => paths.some((path) => inTypecheckProject(scope, path)))
    .map((scope) => normalize(scope.project));
  if (reached.length === 0) return undefined;
  if (reached.length === projects.length) return everyProject();
  return {
    command: 'typecheck',
    args: [...new Set(reached)].sort().flatMap((project) => ['--project', project]),
  };
}

/**
 * The task's `types` obligation, a static step that runs before any build, or
 * none when the project has no typecheck block or the change reaches no project.
 */
export function typesObligation(
  changed: readonly ChangedPath[],
  typecheck: PlanTypecheck | undefined,
  structural: boolean
): Obligation[] {
  const step = typecheck === undefined ? undefined : typecheckStep(changed, typecheck, structural);
  if (step === undefined) return [];
  const fingerprints = [stepFingerprint(step)];
  if (step.args.length > 0) fingerprints.push(stepFingerprint(everyProject()));
  return [
    {
      id: 'types',
      kind: 'static',
      reason: 'The typecheck projects holding what changed, typed as the gate check types them.',
      step,
      fingerprints,
    },
  ];
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;

/** The membership patterns a jsconfig's text states. Unreadable text states none. */
export function jsconfigScope(project: string, text: string | undefined): TypecheckProjectScope {
  const raw: unknown =
    text === undefined ? undefined : parse(text, [], { allowTrailingComma: true });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { project };
  const { files, include, exclude } = raw as Record<string, unknown>;
  const lists = {
    files: stringList(files),
    include: stringList(include),
    exclude: stringList(exclude),
  };
  return {
    project,
    ...(lists.files === undefined ? {} : { files: lists.files }),
    ...(lists.include === undefined ? {} : { include: lists.include }),
    ...(lists.exclude === undefined ? {} : { exclude: lists.exclude }),
  };
}

/**
 * Reads each configured project's jsconfig from the capture: an engine one from
 * the authored files, a root one from the inputs. One the capture does not hold
 * (an upstream jsconfig) is scoped to its whole directory, which over-selects.
 */
export async function capturedTypecheck(
  snapshot: AuthoredSnapshot,
  typecheck: TypecheckConfig | undefined
): Promise<PlanTypecheck | undefined> {
  if (typecheck === undefined || typecheck.projects.length === 0) return undefined;
  const blobOf = (project: string): string | undefined => {
    const path = normalize(project);
    if (path.startsWith('engine/')) {
      const file = snapshot.files.find((entry) => entry.path === path.slice('engine/'.length));
      return file?.kind === 'delete' ? undefined : file?.blob;
    }
    return snapshot.inputs.find((entry) => entry.path === path)?.blob;
  };
  const blobs = typecheck.projects.map(blobOf);
  const read = await readSourceBlobs(
    snapshot.repository,
    blobs.filter((blob): blob is string => blob !== undefined)
  );
  const projects = typecheck.projects.map((project, index) => {
    const bytes = read.get(blobs[index] ?? '');
    return jsconfigScope(project, bytes?.toString('utf8'));
  });
  const shims = [typecheck.extraShim, ...Object.values(typecheck.projectOverrides ?? {})].filter(
    (path): path is string => typeof path === 'string'
  );
  return { projects, shims };
}

/** The plan's `typecheck` input for a capture, empty when it declares no project. */
export async function typecheckInput(
  snapshot: AuthoredSnapshot
): Promise<{ typecheck?: PlanTypecheck }> {
  const typecheck = await capturedTypecheck(snapshot, snapshot.config.typecheck);
  return typecheck === undefined ? {} : { typecheck };
}
