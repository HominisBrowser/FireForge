// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared CSS fragments for Furnace widgets.
 *
 * Shadow-DOM isolation forces each widget stylesheet to carry its own copy
 * of genuinely shared CSS (keyframes, resets), and hand-syncing those copies
 * drifts. Instead, a workspace stylesheet declares an include directive
 * (a CSS block comment on its own line):
 *
 *     @fireforge-include shared-anims.css
 *
 * naming a fragment file in `components/shared/`. `furnace deploy` expands
 * the fragment into the *deployed* copy only (the workspace source stays
 * DRY), fencing the expansion between the directive line and a matching
 * `@fireforge-end-include` marker so re-deploys can refresh it idempotently.
 *
 * Drift contract: the apply fast-path and `furnace validate` compare the
 * *expanded* workspace source against the engine copy, so editing a fragment
 * surfaces as ordinary component drift and the next deploy refreshes every
 * consuming widget.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { ValidationIssue } from '../types/furnace.js';
import { copyFile, pathExists, readText, writeText } from '../utils/fs.js';

export { SHARED_FRAGMENTS_DIR } from './furnace-config.js';

// Local copy of the directory name for message text. Importing the
// binding for value use keeps a single source of truth.
import { SHARED_FRAGMENTS_DIR } from './furnace-config.js';

const INCLUDE_PATTERN = /^\s*\/\*\s*@fireforge-include\s+([\w./-]+)\s*\*\/\s*$/;
const END_INCLUDE_PATTERN = /^\s*\/\*\s*@fireforge-end-include\s+([\w./-]+)\s*\*\/\s*$/;

/** Returns the fragment names referenced by `@fireforge-include` directives. */
export function listFragmentIncludes(css: string): string[] {
  const names: string[] = [];
  for (const line of css.split('\n')) {
    const m = INCLUDE_PATTERN.exec(line);
    if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Collapses fenced fragment expansions back to their bare directives.
 * Inverse of {@link expandCssFragments}. Used to compare a deployed file
 * against its workspace source and to re-expand idempotently.
 */
export function stripExpandedFragments(css: string): string {
  const lines = css.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    out.push(line);
    const inc = INCLUDE_PATTERN.exec(line);
    if (!inc?.[1]) continue;
    // A bare directive (workspace file) has no fence to strip. Only skip
    // the expansion body when a matching end marker actually follows.
    // Otherwise an unterminated fence would silently eat the rest of the
    // file.
    let endIndex = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (END_INCLUDE_PATTERN.exec(lines[j] ?? '')?.[1] === inc[1]) {
        endIndex = j;
        break;
      }
    }
    if (endIndex !== -1) i = endIndex;
  }
  return out.join('\n');
}

/**
 * Expands every `@fireforge-include` directive in `css` with the current
 * content of its fragment file from `sharedDir`, fencing each expansion
 * with an end marker. Existing expansions are stripped first, so the
 * operation is idempotent and refreshes stale content.
 *
 * @param css - Stylesheet source (workspace or previously expanded)
 * @param sharedDir - Absolute path to the shared fragments directory
 * @returns Expanded stylesheet and the fragment names it consumed
 * @throws FurnaceError when a fragment is missing or itself contains an
 *   include directive (nesting is not supported)
 */
export async function expandCssFragments(
  css: string,
  sharedDir: string
): Promise<{ expanded: string; includes: string[] }> {
  const stripped = stripExpandedFragments(css);
  const includes = listFragmentIncludes(stripped);
  if (includes.length === 0) return { expanded: stripped, includes };

  const fragments = new Map<string, string>();
  for (const name of includes) {
    const fragmentPath = join(sharedDir, name);
    if (!(await pathExists(fragmentPath))) {
      throw new FurnaceError(
        `CSS fragment "${name}" not found in components/${SHARED_FRAGMENTS_DIR}/. ` +
          'Create the fragment file or remove the @fireforge-include directive.'
      );
    }
    const content = await readText(fragmentPath);
    if (listFragmentIncludes(content).length > 0) {
      throw new FurnaceError(
        `CSS fragment "${name}" contains an @fireforge-include directive of its own; ` +
          'nested fragment includes are not supported.'
      );
    }
    fragments.set(name, content.replace(/\n$/, ''));
  }

  const out: string[] = [];
  for (const line of stripped.split('\n')) {
    out.push(line);
    const inc = INCLUDE_PATTERN.exec(line);
    if (inc?.[1]) {
      out.push(fragments.get(inc[1]) ?? '');
      out.push(`/* @fireforge-end-include ${inc[1]} */`);
    }
  }
  return { expanded: out.join('\n'), includes };
}

/**
 * Extracts the fenced expansion bodies of a previously expanded stylesheet,
 * keyed by fragment name. Used by validate to compare a deployed expansion
 * against the current fragment source without re-deploying.
 */
export function extractExpandedFragmentBodies(css: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const lines = css.split('\n');
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of lines) {
    if (current !== null) {
      if (END_INCLUDE_PATTERN.exec(line)?.[1] === current) {
        bodies.set(current, buffer.join('\n'));
        current = null;
        buffer = [];
        continue;
      }
      buffer.push(line);
      continue;
    }
    const inc = INCLUDE_PATTERN.exec(line);
    if (inc?.[1]) {
      current = inc[1];
    }
  }
  return bodies;
}

/**
 * Deploys one component file: CSS sources carrying include directives are
 * written as their fragment-expanded form. Everything else is a plain
 * copy. Extracted here so `applyCustomComponent` stays inside the
 * per-file line budget.
 *
 * @returns True when fragment expansion was applied
 */
export async function deployFileWithFragments(
  src: string,
  dest: string,
  sharedDir: string
): Promise<boolean> {
  if (src.endsWith('.css')) {
    const content = await readText(src);
    if (listFragmentIncludes(content).length > 0) {
      const { expanded } = await expandCssFragments(content, sharedDir);
      await writeText(dest, expanded);
      return true;
    }
  }
  await copyFile(src, dest);
  return false;
}

/**
 * Builds the dry-run description suffix for a component file copy,
 * naming the fragments an expansion would inline. Empty for plain copies.
 */
export async function describeFragmentExpansion(src: string): Promise<string> {
  if (!src.endsWith('.css')) return '';
  const includes = listFragmentIncludes(await readText(src));
  if (includes.length === 0) return '';
  return ` (expanding fragment${includes.length === 1 ? '' : 's'}: ${includes.join(', ')})`;
}

/**
 * Validates fragment usage for one custom component: every directive must
 * name an existing fragment (`missing-fragment`, error), and a deployed
 * stylesheet's fenced expansion must match the current fragment source
 * (`stale-fragment-expansion`, warning → redeploy refreshes it).
 *
 * @param componentDir - Workspace directory of the component
 * @param tagName - Component tag name for issue attribution
 * @param sharedDir - Shared fragments directory
 * @param engineTargetDir - Deployed directory in the engine. Optional, and
 *   pre-deploy validation skips the staleness check.
 */
export async function validateCssFragments(
  componentDir: string,
  tagName: string,
  sharedDir: string,
  engineTargetDir?: string
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (!(await pathExists(componentDir))) return issues;

  // Graceful degradation like the other validators: an unreadable
  // component directory must not cascade into a validation crash.
  let entries: string[];
  try {
    entries = await readdir(componentDir);
  } catch {
    // An unreadable component directory contributes no fragment issues.
    // Return what has been collected so far rather than failing validation.
    return issues;
  }
  for (const fileName of entries) {
    if (!fileName.endsWith('.css')) continue;
    const source = await readText(join(componentDir, fileName));
    const includes = listFragmentIncludes(source);
    if (includes.length === 0) continue;

    let deployedBodies: Map<string, string> | null = null;
    if (engineTargetDir) {
      const destPath = join(engineTargetDir, fileName);
      if (await pathExists(destPath)) {
        deployedBodies = extractExpandedFragmentBodies(await readText(destPath));
      }
    }

    for (const include of includes) {
      const fragmentPath = join(sharedDir, include);
      if (!(await pathExists(fragmentPath))) {
        issues.push({
          component: tagName,
          severity: 'error',
          check: 'missing-fragment',
          message:
            `${fileName} includes CSS fragment "${include}", but components/${SHARED_FRAGMENTS_DIR}/${include} does not exist. ` +
            'Create the fragment or remove the @fireforge-include directive.',
        });
        continue;
      }
      if (deployedBodies === null) continue;
      const fragmentContent = (await readText(fragmentPath)).replace(/\n$/, '');
      const deployed = deployedBodies.get(include);
      if (deployed === undefined || deployed !== fragmentContent) {
        issues.push({
          component: tagName,
          severity: 'warning',
          check: 'stale-fragment-expansion',
          message:
            deployed === undefined
              ? `Deployed ${fileName} has no expansion for fragment "${include}". Run "fireforge furnace deploy ${tagName}".`
              : `Deployed ${fileName} carries a stale expansion of fragment "${include}" — the fragment source changed since the last deploy. Run "fireforge furnace deploy ${tagName}".`,
        });
      }
    }
  }
  return issues;
}
