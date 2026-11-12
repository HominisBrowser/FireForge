// SPDX-License-Identifier: EUPL-1.2
/**
 * `typecheck --explain <file>`: which programs see one file, and how,
 * without checking anything. Assembled from the functions the programs are
 * built with, so it cannot drift from them.
 */
import { isAbsolute, join, relative } from 'node:path';

import { exists, isInside, toPosixPath } from '../kernel/fs.js';
import type { JsonObject } from '../kernel/json.js';
import { explainOwnedTypes, loadTypeScript, type OwnedTypesView } from '../lint/index.js';
import {
  displayPath,
  optsOut,
  parseProject,
  projectLayout,
  projectShim,
  projectsOf,
  resolveProjectPath,
  type TypecheckRequest,
} from './typecheck.js';

/** How one configured project relates to the file. */
export interface ProjectView {
  readonly project: string;
  /**
   * `root`: the project lists the file; `not-root`: only an import reaches
   * it; `skipped`: the project turns checkJs off; `unreadable`: see `detail`.
   */
  readonly membership: 'root' | 'not-root' | 'skipped' | 'unreadable';
  readonly detail?: string;
  readonly shim?: string;
  readonly litTypes: boolean;
  readonly undefinedIdentifiers: 'off' | 'warning' | 'error';
}

/** The whole explanation. */
export interface Explanation {
  /** The file as the run names it. */
  readonly file: string;
  readonly exists: boolean;
  readonly projects: readonly ProjectView[];
  readonly owned: OwnedTypesView;
}

/** A file a user names (absolute, `engine/…`, or project-relative) as the layout names it. */
function fileInLayout(request: TypecheckRequest, layout: string, file: string): string {
  if (!isAbsolute(file)) return resolveProjectPath(layout, file);
  if (isInside(request.engineDir, file)) {
    return join(layout, 'engine', relative(request.engineDir, file));
  }
  return isInside(request.projectRoot, file)
    ? join(layout, relative(request.projectRoot, file))
    : file;
}

/**
 * Explains how both passes see a file.
 *
 * @param request - The run, as `runTypecheck` would get it
 * @param file - Absolute, `engine/…`, or project-relative
 */
export async function explainTypecheck(
  request: TypecheckRequest,
  file: string
): Promise<Explanation> {
  const layout = await projectLayout(request);
  const absolute = fileInLayout(request, layout, file);
  const { projects, settings } = projectsOf(request);
  const views: ProjectView[] = [];
  const ts = projects.length > 0 ? await loadTypeScript() : undefined;
  for (const project of projects) {
    const shim = projectShim(settings, project);
    const base = {
      project,
      litTypes: settings?.litTypes ?? false,
      undefinedIdentifiers: settings?.undefinedIdentifiers ?? 'warning',
      ...(shim === undefined ? {} : { shim }),
    };
    const configFile = resolveProjectPath(layout, project);
    if (ts === undefined || !(await exists(configFile))) {
      views.push({ ...base, membership: 'unreadable', detail: 'the project file does not exist' });
      continue;
    }
    const read = parseProject(ts, configFile);
    if ('problem' in read) {
      const detail = ts.flattenDiagnosticMessageText(read.problem.messageText, '\n');
      views.push({ ...base, membership: 'unreadable', detail });
      continue;
    }
    const roots = new Set(read.parsed.fileNames.map((name) => join(name)));
    const membership = optsOut(read.raw)
      ? 'skipped'
      : roots.has(join(absolute))
        ? 'root'
        : 'not-root';
    views.push({ ...base, membership });
  }
  const engineInLayout = join(layout, 'engine');
  const enginePath = isInside(engineInLayout, absolute)
    ? toPosixPath(relative(engineInLayout, absolute))
    : undefined;
  const owned: OwnedTypesView =
    enginePath === undefined
      ? { program: 'none', reason: 'the file is not in the engine', heads: [], imports: [] }
      : await explainOwnedTypes(
          request.changes,
          request.engine,
          request.config,
          { projectRoot: request.projectRoot },
          enginePath
        );
  return {
    file: displayPath(request, layout, absolute),
    exists: await exists(absolute),
    projects: views,
    owned,
  };
}

/**
 * The `--json` document of an explanation.
 *
 * @param explanation - The explanation
 */
export function explanationJson(explanation: Explanation): JsonObject {
  const { owned } = explanation;
  return {
    file: explanation.file,
    exists: explanation.exists,
    projects: explanation.projects.map((view) => ({ ...view })),
    owned: {
      program: owned.program,
      reason: owned.reason ?? null,
      heads: [...owned.heads],
      imports: owned.imports.map((entry) => ({ ...entry })),
      shim: owned.shim ?? null,
    },
  };
}

/**
 * Human lines for an explanation.
 *
 * @param explanation - The explanation
 */
export function renderExplanation(explanation: Explanation): string[] {
  const lines = [
    `${explanation.file}${explanation.exists ? '' : ' (does not exist)'}`,
    '',
    'Projects:',
  ];
  if (explanation.projects.length === 0) lines.push('  none configured');
  for (const view of explanation.projects) {
    const detail = view.detail === undefined ? '' : ` (${view.detail})`;
    lines.push(
      `  ${view.project}: ${view.membership}${detail}; shim ${view.shim ?? 'built-in only'}, ` +
        `litTypes ${String(view.litTypes)}, undefinedIdentifiers ${view.undefinedIdentifiers}`
    );
  }
  const owned = explanation.owned;
  lines.push(
    '',
    `Owned files: ${owned.program === 'none' ? `not checked (${owned.reason ?? ''})` : `${owned.program} program`}`
  );
  if (owned.shim !== undefined) lines.push(`  shim ${owned.shim}`);
  for (const head of owned.heads) lines.push(`  head ${head}`);
  for (const entry of owned.imports) {
    lines.push(
      `  import ${entry.specifier}: ${entry.resolution}${entry.target === undefined ? '' : ` ${entry.target}`}`
    );
  }
  return lines;
}
