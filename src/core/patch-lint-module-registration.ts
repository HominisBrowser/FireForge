// SPDX-License-Identifier: EUPL-1.2
/**
 * Queue-wide registration lint for newly-created Firefox system modules.
 */
import { basename } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import { escapeRegex, stripJsComments } from '../utils/regex.js';
import type { PatchQueueRegistrationEntry, PatchQueueView } from './patch-lint-queue-types.js';

type ModuleRegistrationQueueEntry = PatchQueueRegistrationEntry;

type ModuleRegistrationQueueContext = PatchQueueView<PatchQueueRegistrationEntry>;

const IMPORTABLE_EXTENSIONS = ['.mjs', '.sys.mjs', '.js', '.jsm'];

/**
 * Maps Firefox's common system-module resource URLs to their source
 * suffix. Exported alongside {@link extractResourceModuleSpecifiers} so
 * the resolution preflight resolves specifiers identically.
 */
export function moduleSourceSuffix(specifier: string): string | undefined {
  const cleaned = specifier.split(/[?#]/)[0] ?? specifier;
  for (const prefix of ['resource:///modules/', 'resource://gre/modules/']) {
    if (cleaned.startsWith(prefix)) return `/modules/${cleaned.slice(prefix.length)}`;
  }
  return undefined;
}

/**
 * Resource-module strings in actual code (comments removed), de-duplicated.
 * Exported for the engine-aware resolution preflight, which must recognise
 * exactly the same specifier shapes this queue-level rule does. Two
 * extractors would drift.
 */
export function extractResourceModuleSpecifiers(content: string): string[] {
  const stripped = stripJsComments(content);
  const found = new Set<string>();
  const pattern = /["'](resource:\/\/(?:\/|gre\/)modules\/[^"']+\.sys\.mjs(?:[?#][^"']*)?)["']/g;
  for (const match of stripped.matchAll(pattern)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

/** True when some patch in the projected queue adds the module to moz.build. */
function queueRegistersModule(ctx: ModuleRegistrationQueueContext, leaf: string): boolean {
  const escaped = escapeRegex(leaf);
  const quotedLeaf = new RegExp(`["']${escaped}["']`);
  for (const entry of ctx.entries) {
    for (const [path, content] of [...entry.newFiles, ...entry.modifiedFileAdditions]) {
      if ((path === 'moz.build' || path.endsWith('/moz.build')) && quotedLeaf.test(content)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Flags a new `.sys.mjs` imported through a Firefox resource URL when the
 * projected queue never adds it to a moz.build list.
 */
export function lintPatchQueueModuleRegistrations(
  ctx: ModuleRegistrationQueueContext
): PatchLintIssue[] {
  const imported = new Map<string, Set<string>>();
  const collect = (entry: ModuleRegistrationQueueEntry, path: string, content: string): void => {
    if (!IMPORTABLE_EXTENSIONS.some((extension) => path.endsWith(extension))) return;
    for (const specifier of extractResourceModuleSpecifiers(content)) {
      const suffix = moduleSourceSuffix(specifier);
      if (suffix === undefined) continue;
      const importers = imported.get(suffix) ?? new Set<string>();
      importers.add(entry.filename);
      imported.set(suffix, importers);
    }
  };

  for (const entry of ctx.entries) {
    for (const [path, content] of entry.newFiles) collect(entry, path, content);
    for (const [path, content] of entry.modifiedFileAdditions) collect(entry, path, content);
  }

  const issues: PatchLintIssue[] = [];
  for (const entry of ctx.entries) {
    for (const path of entry.newFiles.keys()) {
      if (!path.endsWith('.sys.mjs')) continue;
      const matched = [...imported.entries()].find(([suffix]) => path.endsWith(suffix));
      if (!matched || queueRegistersModule(ctx, basename(path))) continue;
      const [suffix, importers] = matched;
      issues.push({
        file: path,
        check: 'unregistered-system-module',
        patches: [...new Set([entry.filename, ...importers])],
        fingerprint: `unregistered-system-module|${path}|${suffix}`,
        message:
          `${path} is newly created and imported as a resource module, but no patch adds ` +
          `${basename(path)} to a moz.build list. Register it in EXTRA_JS_MODULES (or the ` +
          'appropriate namespaced list) before export; source-level typechecks can resolve the ' +
          'file even though the packaged browser cannot.',
        severity: 'error',
      });
    }
  }
  return issues;
}
