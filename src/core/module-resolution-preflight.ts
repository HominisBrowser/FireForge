// SPDX-License-Identifier: EUPL-1.2
/**
 * Engine-aware resolution preflight for queue-owned system modules.
 *
 * An `.sys.mjs` that a packaged module imports but whose `EXTRA_JS_MODULES`
 * registration never landed kills every xpcshell suite
 * with `xpcshell return code: -11` and ZERO output — no import error, no
 * stack, nothing. The 0.41.0 `unregistered-system-module` check catches
 * this class, but only in one shape: a module NEWLY CREATED by a patch in
 * the projected queue. The class recurred through the other shape — three
 * modules imported from an ALREADY-EXISTING module before their moz.build
 * lines landed — and cost a full rebuild cycle before anyone recognised it.
 *
 * This preflight closes that gap by asking the question against the ENGINE
 * rather than against a projected diff: for every `resource:///modules/…`
 * specifier imported by any queue-owned module, does the module it names
 * exist, and is it registered in a moz.build that covers it?
 *
 * Scope is the queue-owned file set on purpose. A specifier that resolves
 * to no owned file is an UPSTREAM Firefox module, which FireForge does not
 * police and cannot cheaply enumerate; policing only what the fork owns is
 * both the actionable set and the one that produced every recorded
 * incident.
 */

import { dirname, join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { escapeRegex } from '../utils/regex.js';
import {
  extractResourceModuleSpecifiers,
  moduleSourceSuffix,
} from './patch-lint-module-registration.js';

/** Extensions whose contents are scanned for resource-module imports. */
const IMPORTABLE_EXTENSIONS = ['.mjs', '.sys.mjs', '.js', '.jsm'];

/** Why a queue-owned module import does not resolve to a packaged module. */
export type UnresolvedModuleReason = 'missing-file' | 'unregistered';

/** One unresolvable or unregistered system-module import. */
export interface UnresolvedModuleImport {
  /** Engine-relative path of the module the specifier names. */
  module: string;
  /** The `resource://` specifier as written. */
  specifier: string;
  /** Engine-relative paths of the files that import it, sorted. */
  importers: string[];
  reason: UnresolvedModuleReason;
}

/**
 * Reads a file, returning undefined (with a verbose note) rather than
 * throwing: a preflight must not fail a command over one unreadable path.
 */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    if (!(await pathExists(path))) return undefined;
    return await readText(path);
  } catch (error: unknown) {
    verbose(`Module resolution preflight: could not read ${path} — ${toError(error).message}`);
    return undefined;
  }
}

/**
 * True when some `moz.build` at or above `moduleRelPath`'s directory (up
 * to, and including, the engine root) mentions the module's basename.
 *
 * Walking ancestors — rather than checking only the sibling `moz.build` —
 * matches how Mozilla's build system actually works: a module list may sit
 * in a parent directory's `moz.build` with a path-qualified entry. The
 * check is a quoted-basename match for the same reason the queue-level
 * rule uses one: parsing moz.build's Python is not worth it for a
 * preflight, and a quoted basename has no meaningful false-positive shape.
 */
async function isRegisteredInAncestorMozBuild(
  engineDir: string,
  moduleRelPath: string,
  mozBuildCache: Map<string, string | undefined>
): Promise<boolean> {
  const leaf = moduleRelPath.slice(moduleRelPath.lastIndexOf('/') + 1);
  // The entry may be the bare basename (`"Foo.sys.mjs"`, sibling
  // moz.build) or path-qualified relative to the moz.build that declares
  // it (`"sub/Foo.sys.mjs"`, ancestor moz.build). Both are the same
  // registration; anchor on the closing quote and require a path boundary
  // so `NotFoo.sys.mjs` cannot satisfy `Foo.sys.mjs`.
  const quotedLeaf = new RegExp(`["'](?:[^"']*/)?${escapeRegex(leaf)}["']`);
  let dir = dirname(moduleRelPath);
  for (;;) {
    const key = dir === '.' ? '' : dir;
    if (!mozBuildCache.has(key)) {
      mozBuildCache.set(key, await readIfPresent(join(engineDir, key, 'moz.build')));
    }
    const content = mozBuildCache.get(key);
    if (content !== undefined && quotedLeaf.test(content)) return true;
    if (dir === '.' || dir === '' || dir === '/') return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Resolves every `resource://` system-module import made by the
 * queue-owned files and reports the ones a packaged browser could not
 * load.
 *
 * @param engineDir - Path to the engine checkout
 * @param ownedFiles - Engine-relative paths the patch queue owns
 * @returns Findings sorted by module path; empty when everything resolves
 */
export async function findUnresolvedSystemModuleImports(
  engineDir: string,
  ownedFiles: readonly string[]
): Promise<UnresolvedModuleImport[]> {
  const owned = [...new Set(ownedFiles)];

  /** specifier → importing owned files. */
  const importersBySpecifier = new Map<string, Set<string>>();
  for (const file of owned) {
    if (!IMPORTABLE_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    const content = await readIfPresent(join(engineDir, file));
    if (content === undefined) continue;
    for (const specifier of extractResourceModuleSpecifiers(content)) {
      const importers = importersBySpecifier.get(specifier) ?? new Set<string>();
      importers.add(file);
      importersBySpecifier.set(specifier, importers);
    }
  }

  const mozBuildCache = new Map<string, string | undefined>();
  const findings: UnresolvedModuleImport[] = [];
  for (const [specifier, importers] of importersBySpecifier) {
    const suffix = moduleSourceSuffix(specifier);
    if (suffix === undefined) continue;
    // Only fork-owned targets are policed; anything else is upstream.
    const target = owned.find((file) => file.endsWith(suffix));
    if (target === undefined) continue;

    const sortedImporters = [...importers].sort((a, b) => a.localeCompare(b));
    if (!(await pathExists(join(engineDir, target)))) {
      findings.push({
        module: target,
        specifier,
        importers: sortedImporters,
        reason: 'missing-file',
      });
      continue;
    }
    if (!(await isRegisteredInAncestorMozBuild(engineDir, target, mozBuildCache))) {
      findings.push({
        module: target,
        specifier,
        importers: sortedImporters,
        reason: 'unregistered',
      });
    }
  }

  // Deterministic order regardless of Map iteration or owned-file order.
  return findings.sort(
    (a, b) => a.module.localeCompare(b.module) || a.specifier.localeCompare(b.specifier)
  );
}

/**
 * Renders findings as operator-facing lines, naming the unregistered or
 * unresolvable module, so the failure is a sentence instead of a bare
 * `-11`.
 */
export function formatUnresolvedSystemModuleImports(
  findings: readonly UnresolvedModuleImport[]
): string[] {
  return findings.map((finding) =>
    finding.reason === 'missing-file'
      ? `${finding.module}: imported as ${finding.specifier} by ${finding.importers.join(', ')}, ` +
        'but the file does not exist in engine/. A packaged browser cannot load it; xpcshell ' +
        'dies on SIGSEGV with no output.'
      : `${finding.module}: imported as ${finding.specifier} by ${finding.importers.join(', ')}, ` +
        'but no moz.build at or above its directory registers it. Add it to EXTRA_JS_MODULES ' +
        '(or the appropriate namespaced module list) — until then a packaged browser cannot ' +
        'load it and xpcshell dies on SIGSEGV with no output.'
  );
}
