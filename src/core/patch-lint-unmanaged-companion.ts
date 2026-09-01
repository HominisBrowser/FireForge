// SPDX-License-Identifier: EUPL-1.2
/**
 * Recognizes the one shape where the undefined-identifier hint sends the
 * operator at the wrong remedy — and where taking that remedy would MASK a
 * real bug.
 *
 * The shape: helpers are hoisted out of duplicated test files into a new
 * `head_settings.js` that a managed `head.js` pulls in with
 * `loadSubScript`. Until that companion is exported it belongs to no patch,
 * so the per-patch checkJs program — which only ever loads patch-owned
 * roots — cannot see any of its declarations. Every use of every hoisted
 * helper is then reported as `Cannot find name`, and the generic hint
 * offers three remedies of which the shim is the easiest: adding the
 * globals to `extraShim` makes all of the warnings disappear AND makes a
 * genuinely missing helper undetectable forever after.
 *
 * The warnings themselves are correct — the per-patch program's honest view
 * of a file that is in no patch. Only the advice is wrong. FireForge
 * already knows ownership, so when every undefined name in a file is
 * declared at the top level of an UNMANAGED file that a managed head loads,
 * it can name that file and the adoption command instead.
 *
 * Detection is deliberately conservative on both halves: a companion must
 * be reachable from an actual `loadSubScript` call, and EVERY undefined
 * name must resolve inside it. One unresolved name means the file may
 * genuinely be missing a helper, and the generic hint stays.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import { UNDEFINED_IDENTIFIER_HINT } from './typecheck-shim.js';

/**
 * String literals passed anywhere inside a `loadSubScript(...)` call.
 *
 * The mochitest idiom is
 * `Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_settings.js", this)`,
 * so the useful signal is the `.js` literal inside the call, not a
 * resolvable URL — the path half is computed at runtime.
 */
export function findLoadSubScriptTargets(source: string): string[] {
  const targets: string[] = [];
  // Scanned to the statement terminator rather than to a closing paren:
  // the idiomatic argument is itself a call (`getRootDirectory(gTestPath) +
  // "head_settings.js"`), so a non-greedy `\)` stops on the INNER paren and
  // never reaches the literal.
  for (const call of source.matchAll(/loadSubScript\s*\(/g)) {
    const from = call.index + call[0].length;
    const semicolon = source.indexOf(';', from);
    const to =
      semicolon === -1 ? from + CALL_SCAN_LIMIT : Math.min(semicolon, from + CALL_SCAN_LIMIT);
    for (const literal of source.slice(from, to).matchAll(/["'`]([^"'`]*\.js)["'`]/g)) {
      const value = literal[1];
      if (value !== undefined && value.length > 0) targets.push(value);
    }
  }
  return targets;
}

/** How far past a `loadSubScript(` the argument scan looks. */
const CALL_SCAN_LIMIT = 400;

/**
 * Top-level declaration names in a script-scope file.
 *
 * Regex rather than a TS program on purpose: this runs only to decide the
 * WORDING of a hint, the file is by definition outside every program the
 * pass built, and a missed declaration degrades to the generic hint rather
 * than to a wrong answer. Matching is anchored at column zero so a nested
 * declaration inside a function body is not mistaken for a global.
 */
export function collectTopLevelDeclarations(source: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * Extracts the identifier from a `Cannot find name 'X'` diagnostic message,
 * or undefined when the message is not one.
 */
function extractUndefinedIdentifier(message: string): string | undefined {
  const match = /Cannot find name '([^']+)'/.exec(message);
  return match?.[1];
}

/** An unmanaged companion a managed head loads, plus what it declares. */
export interface UnmanagedCompanion {
  /** Repo-relative path of the companion. */
  file: string;
  /** Repo-relative path of the managed head that loads it. */
  loadedBy: string;
  /** Top-level names the companion declares. */
  declarations: Set<string>;
}

/**
 * Resolves the unmanaged companions reachable from a set of managed head
 * files, given a reader for repo-relative file content.
 *
 * A candidate qualifies only when it is NOT in `ownedFiles` and its content
 * can be read — an unreadable or absent target is simply not a companion,
 * and the generic hint applies.
 *
 * @param heads - Repo-relative managed head files, with their sources
 * @param ownedFiles - Every patch-owned repo-relative path
 * @param readFile - Reads a repo-relative file, or returns undefined
 */
export async function resolveUnmanagedCompanions(
  heads: ReadonlyArray<{ file: string; source: string }>,
  ownedFiles: ReadonlySet<string>,
  readFile: (repoRelative: string) => Promise<string | undefined>
): Promise<UnmanagedCompanion[]> {
  const companions: UnmanagedCompanion[] = [];
  const seen = new Set<string>();
  for (const head of heads) {
    const dir = head.file.slice(0, head.file.lastIndexOf('/') + 1);
    for (const target of findLoadSubScriptTargets(head.source)) {
      // Only same-directory targets: the runtime path is computed from the
      // test's own directory, and a bare basename is what that idiom yields.
      const candidate = `${dir}${target.slice(target.lastIndexOf('/') + 1)}`;
      if (candidate === head.file || ownedFiles.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      const source = await readFile(candidate);
      if (source === undefined) continue;
      companions.push({
        file: candidate,
        loadedBy: head.file,
        declarations: collectTopLevelDeclarations(source),
      });
    }
  }
  return companions;
}

/**
 * The replacement hint, when every undefined name resolves in one
 * unmanaged companion.
 *
 * States the ownership fact first (that is the diagnosis), then the
 * adoption command, and explicitly rules the shim OUT — the shim is what an
 * operator reaches for by default here, and it is the one remedy that
 * permanently hides a genuinely missing helper.
 */
export function formatUnmanagedCompanionHint(companion: UnmanagedCompanion): string {
  return (
    `(undefined identifier — every one of them is declared in ${companion.file}, which ` +
    `${companion.loadedBy} loads via loadSubScript but which NO patch owns yet, so the ` +
    `per-patch program cannot see it. Adopt it with ` +
    `"fireforge re-export <patch> --scan --scan-file ${companion.file}". Do NOT add these ` +
    `globals to the extra shim: that silences these warnings and every future genuinely ` +
    `missing helper with them.)`
  );
}

/**
 * Picks the companion that explains EVERY undefined identifier in
 * `messages`, or undefined when none does.
 *
 * @param messages - Diagnostic messages reported for one file
 * @param companions - Candidates from {@link resolveUnmanagedCompanions}
 */
export function explainUndefinedIdentifiers(
  messages: readonly string[],
  companions: readonly UnmanagedCompanion[]
): UnmanagedCompanion | undefined {
  const names = messages
    .map((message) => extractUndefinedIdentifier(message))
    .filter((name): name is string => name !== undefined);
  if (names.length === 0) return undefined;
  // Only the undefined-identifier diagnostics are explained here; a file
  // carrying OTHER type errors still gets those reported untouched.
  return companions.find((companion) => names.every((name) => companion.declarations.has(name)));
}

/**
 * Reads the head files in the owned test set and resolves the UNMANAGED
 * companions they pull in with `loadSubScript`. Hoisting shared helpers
 * into such a companion leaves it unowned until export, and every use of
 * every helper then reports `Cannot find name` from an honest per-patch
 * program — see `patch-lint-unmanaged-companion.ts` for why the generic
 * hint is actively harmful there.
 *
 * Best-effort: an unreadable head simply contributes no companions.
 */
export async function collectUnmanagedCompanions(
  repoDir: string,
  files: readonly string[],
  ownedFiles: ReadonlySet<string>
): Promise<UnmanagedCompanion[]> {
  const heads: { file: string; source: string }[] = [];
  for (const file of files) {
    const base = file.split('/').pop() ?? '';
    if (!/^head(?:_.*)?\.js$/.test(base)) continue;
    try {
      heads.push({ file, source: await readFile(join(repoDir, file), 'utf8') });
    } catch {
      continue;
    }
  }
  if (heads.length === 0) return [];
  return resolveUnmanagedCompanions(heads, ownedFiles, async (rel) => {
    try {
      return await readFile(join(repoDir, rel), 'utf8');
    } catch {
      return undefined;
    }
  });
}

/**
 * Swaps the generic undefined-identifier hint for the ownership hint when
 * one unmanaged companion explains EVERY undefined name in the file. Any
 * other issue in the list is returned untouched.
 */
export function retargetUnmanagedCompanionHints(
  issues: readonly PatchLintIssue[],
  companions: readonly UnmanagedCompanion[]
): PatchLintIssue[] {
  if (companions.length === 0) return [...issues];
  const undefinedIssues = issues.filter((issue) =>
    issue.message.includes(UNDEFINED_IDENTIFIER_HINT)
  );
  if (undefinedIssues.length === 0) return [...issues];
  const companion = explainUndefinedIdentifiers(
    undefinedIssues.map((issue) => issue.message),
    companions
  );
  if (!companion) return [...issues];
  const hint = formatUnmanagedCompanionHint(companion);
  return issues.map((issue) =>
    issue.message.includes(UNDEFINED_IDENTIFIER_HINT)
      ? { ...issue, message: issue.message.replace(UNDEFINED_IDENTIFIER_HINT, hint) }
      : issue
  );
}
