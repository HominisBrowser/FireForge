// SPDX-License-Identifier: EUPL-1.2
/**
 * Prints `fireforge typecheck --explain <file>`: the project pass and the
 * per-patch checkJs view of one file, side by side. The explanation itself
 * is assembled in `core/typecheck-explain.ts`.
 */

import type {
  PerPatchExplanation,
  ProjectExplanation,
  TypecheckExplanation,
} from '../core/typecheck-explain.js';

function describeProject(project: ProjectExplanation): string[] {
  const source =
    project.overrideKey !== undefined
      ? ` (projectOverrides "${project.overrideKey}")`
      : project.extraShim !== undefined
        ? ' (typecheck.extraShim)'
        : '';
  const settings =
    `litTypes ${project.litTypes ? 'on' : 'off'}; ` +
    `extra shim ${project.extraShim ?? 'none'}${source}; ` +
    `undefinedIdentifiers ${project.undefinedIdentifiers}`;
  switch (project.membership) {
    case 'root':
      return [`${project.project}: checks it as a root.`, `  ${settings}`];
    case 'not-root':
      return [
        `${project.project}: does not list it; checks it only when one of its roots imports it.`,
        `  ${settings}`,
      ];
    case 'skipped':
      return [`${project.project}: sets "checkJs: false", so the run skips the project.`];
    case 'unreadable':
      return [`${project.project}: cannot be read (${project.detail ?? 'unknown error'}).`];
  }
}

function describeImports(perPatch: PerPatchExplanation): string[] {
  if (perPatch.imports.length === 0) return ['URL imports: none.'];
  const lines = ['URL imports:'];
  for (const entry of perPatch.imports) {
    if (entry.resolution === 'owned') {
      lines.push(`  ${entry.specifier} -> ${entry.target ?? ''}`);
    } else if (entry.resolution === 'paths') {
      lines.push(`  ${entry.specifier} -> ${entry.target ?? ''} (checkJsCompilerOptions.paths)`);
    } else {
      lines.push(`  ${entry.specifier} -> any`);
    }
  }
  if (perPatch.imports.some((entry) => entry.resolution === 'any')) {
    lines.push(
      'An import shown as any resolves to no module of this program (a later patch creates ' +
        'it, it is upstream, or two patches create the basename). It and every member ' +
        'reference through it (import("…").Type, typeof import("…").member) type as any here; ' +
        'the project pass checks them against the real module when its jsconfig resolves the URL.'
    );
  }
  return lines;
}

function describePerPatch(perPatch: PerPatchExplanation): string[] {
  const lines: string[] = [];
  if (perPatch.creators.length > 0) lines.push(`Created by ${perPatch.creators.join(', ')}.`);
  if (perPatch.modifiers.length > 0) lines.push(`Modified by ${perPatch.modifiers.join(', ')}.`);
  if (perPatch.program === 'none') {
    lines.push(`Not checked per patch: ${perPatch.reason ?? 'no program roots it'}.`);
    return lines;
  }
  lines.push(
    perPatch.program === 'module'
      ? 'Checked as a root of the queue-wide .sys.mjs program.'
      : 'Checked as a test script, in its own program.'
  );
  if (perPatch.program === 'test') {
    lines.push(
      perPatch.heads.length > 0
        ? `Heads loaded beside it: ${perPatch.heads.join(', ')}.`
        : 'Heads loaded beside it: none (only patch-owned head*.js in its directory are).'
    );
  }
  lines.push(
    `Shim: built-in Firefox globals${perPatch.program === 'test' ? ' + test harness' : ''}` +
      (perPatch.shim !== undefined ? ` + ${perPatch.shim}` : '') +
      `; litTypes ${perPatch.litTypes ? 'on' : 'off'}; strict ${perPatch.strict ? 'on' : 'off'}; ` +
      `undefinedIdentifiers ${perPatch.undefinedIdentifiers}.`
  );
  lines.push(
    `Modules its imports can resolve to (${perPatch.resolvable.length})` +
      (perPatch.resolvable.length > 0 ? `:\n  ${perPatch.resolvable.join('\n  ')}` : '.')
  );
  lines.push(...describeImports(perPatch));
  lines.push(
    'A global no shim declares is an undefined identifier here even when a chrome script the ' +
      'project pass loads declares it.'
  );
  return lines;
}

/**
 * Renders an explanation as titled blocks of lines for the terminal.
 *
 * @param explanation - From `explainTypecheckFile`
 * @returns `[title, lines]` pairs, in print order
 */
export function formatTypecheckExplanation(
  explanation: TypecheckExplanation
): Array<[string, string[]]> {
  const projects =
    explanation.projects.length > 0
      ? explanation.projects.flatMap(describeProject)
      : ['No typecheck.projects are configured.'];
  return [
    [
      `File: ${explanation.file}`,
      explanation.exists ? [] : ['The file does not exist; showing what would apply to it.'],
    ],
    ['Project pass (typecheck.projects)', projects],
    ['Per-patch checkJs', describePerPatch(explanation.perPatch)],
  ];
}
