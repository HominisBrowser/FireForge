// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest scaffolding for `fireforge register --create-manifest`.
 *
 * `register` only inserts into EXISTING manifests, so registering a module
 * under a directory with no moz.build fails with "Manifest not found". This
 * module owns the two scaffolding primitives:
 *
 *  - creating a directory `moz.build` (license header + the requested list
 *    directive) and wiring the parent chain's `DIRS` entries up to the
 *    nearest existing moz.build;
 *  - wiring an `XPCSHELL_TESTS_MANIFESTS` entry for a (possibly freshly
 *    created) `xpcshell.toml` into the nearest existing moz.build.
 *
 * All writers reuse the tokenizer + alphabetical-position helpers the
 * existing register writers use, so inserted entries respect mozbuild's
 * case-insensitive StrictOrderingOnAppendList rule.
 */

import { dirname, join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { getLicenseHeader } from './license-headers.js';
import { findAlphabeticalMozBuildPosition } from './moz-manifest-helpers.js';
import { tokenizeMozBuildList } from './moz-manifest-tokenizers.js';

/** One manifest mutation performed (or planned, on dry-run) by a scaffold. */
export interface ScaffoldAction {
  /** Engine-relative manifest path that was created or modified. */
  manifest: string;
  /** Human-readable description of the change. */
  change: string;
}

/**
 * moz.build files use Firefox's canonical MPL-2.0 hash-comment header
 * regardless of the fork's own project license — they live in the engine
 * tree among upstream MPL files.
 */
function mozBuildHeader(): string {
  return getLicenseHeader('MPL-2.0', 'hash');
}

/**
 * Inserts `value` into the named moz.build list directive, creating the
 * `NAME += [ ... ]` block at the end of the file when the directive does
 * not exist yet. Returns the updated content, or null when the value is
 * already present.
 */
export function upsertMozBuildListEntry(
  content: string,
  directive: string,
  value: string
): string | null {
  if (content.includes(`"${value}"`)) return null;

  const lines = content.split('\n');
  const listResult = tokenizeMozBuildList(lines, new RegExp(`^${directive}\\b`));
  if (listResult) {
    const { insertIndex } = findAlphabeticalMozBuildPosition(listResult.tokens, value);
    lines.splice(insertIndex, 0, `    "${value}",`);
    return lines.join('\n');
  }

  // No existing list: append a fresh block, keeping exactly one blank
  // line between the previous content and the new directive.
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  const block = [`${directive} += [`, `    "${value}",`, `]`];
  return [...lines, ...(lines.length > 0 ? [''] : []), ...block, ''].join('\n');
}

/**
 * Ensures every parent directory between `childRelDir` and the nearest
 * existing moz.build carries a `DIRS` entry pointing at the next segment
 * down, creating intermediate moz.build files as needed. Walks upward
 * from the child's parent; throws when no moz.build exists anywhere up
 * to the engine root (an engine checkout always has one at the root, so
 * this indicates a bogus path).
 */
export async function ensureParentDirsWiring(
  engineDir: string,
  childRelDir: string,
  dryRun: boolean
): Promise<ScaffoldAction[]> {
  const actions: ScaffoldAction[] = [];
  let childName = childRelDir.split('/').at(-1) ?? childRelDir;
  let parentRel = normalizePathSlashes(dirname(childRelDir));

  for (;;) {
    if (parentRel === '.' || parentRel === '' || parentRel === '/') {
      throw new GeneralError(
        `No moz.build found in any parent of ${childRelDir} up to the engine root; ` +
          'cannot wire the DIRS chain. Check the path.'
      );
    }
    const parentManifestRel = `${parentRel}/moz.build`;
    const parentManifestPath = join(engineDir, parentManifestRel);

    if (await pathExists(parentManifestPath)) {
      const content = await readText(parentManifestPath);
      const updated = upsertMozBuildListEntry(content, 'DIRS', childName);
      if (updated !== null) {
        if (!dryRun) await writeText(parentManifestPath, updated);
        actions.push({ manifest: parentManifestRel, change: `DIRS += ["${childName}"]` });
      }
      return actions;
    }

    // Parent has no moz.build either: scaffold one carrying the DIRS
    // entry and keep walking up until an existing manifest anchors the
    // chain.
    const scaffold = `${mozBuildHeader()}\n\nDIRS += [\n    "${childName}",\n]\n`;
    if (!dryRun) await writeText(parentManifestPath, scaffold);
    actions.push({ manifest: parentManifestRel, change: `created with DIRS += ["${childName}"]` });
    childName = parentRel.split('/').at(-1) ?? parentRel;
    parentRel = normalizePathSlashes(dirname(parentRel));
  }
}

/**
 * Creates `<moduleDir>/moz.build` with an `EXTRA_JS_MODULES.<namespace>`
 * list containing `fileName`, and wires the parent DIRS chain. The
 * namespace is the module directory's basename (the fork's binary name
 * for `browser/modules/<binaryName>/`), matching Firefox's convention of
 * mapping `EXTRA_JS_MODULES.<ns>` into `resource:///modules/<ns>/`.
 */
export async function scaffoldModuleMozBuild(
  engineDir: string,
  moduleDir: string,
  fileName: string,
  dryRun: boolean
): Promise<ScaffoldAction[]> {
  const namespace = moduleDir.split('/').at(-1) ?? moduleDir;
  const manifestRel = `${moduleDir}/moz.build`;
  const content = `${mozBuildHeader()}\n\nEXTRA_JS_MODULES.${namespace} += [\n    "${fileName}",\n]\n`;
  if (!dryRun) await writeText(join(engineDir, manifestRel), content);
  const actions: ScaffoldAction[] = [
    {
      manifest: manifestRel,
      change: `created with EXTRA_JS_MODULES.${namespace} += ["${fileName}"]`,
    },
  ];
  actions.push(...(await ensureParentDirsWiring(engineDir, moduleDir, dryRun)));
  return actions;
}

/**
 * Wires an `XPCSHELL_TESTS_MANIFESTS` entry for `manifestRelPath` (an
 * engine-relative `.../xpcshell.toml`) into the nearest EXISTING
 * moz.build above it. Returns the performed actions (empty when the
 * entry already exists).
 */
export async function ensureXpcshellManifestWiring(
  engineDir: string,
  manifestRelPath: string,
  dryRun: boolean
): Promise<ScaffoldAction[]> {
  let dirRel = normalizePathSlashes(dirname(manifestRelPath));

  for (;;) {
    if (dirRel === '.' || dirRel === '' || dirRel === '/') {
      throw new GeneralError(
        `No moz.build found in any parent of ${manifestRelPath} up to the engine root; ` +
          'cannot wire XPCSHELL_TESTS_MANIFESTS. Check the path.'
      );
    }
    const mozBuildRel = `${dirRel}/moz.build`;
    const mozBuildPath = join(engineDir, mozBuildRel);
    if (await pathExists(mozBuildPath)) {
      const relEntry = manifestRelPath.slice(dirRel.length + 1);
      const content = await readText(mozBuildPath);
      const updated = upsertMozBuildListEntry(content, 'XPCSHELL_TESTS_MANIFESTS', relEntry);
      if (updated === null) return [];
      if (!dryRun) await writeText(mozBuildPath, updated);
      return [{ manifest: mozBuildRel, change: `XPCSHELL_TESTS_MANIFESTS += ["${relEntry}"]` }];
    }
    dirRel = normalizePathSlashes(dirname(dirRel));
  }
}
