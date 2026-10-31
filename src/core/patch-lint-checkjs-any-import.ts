// SPDX-License-Identifier: EUPL-1.2
/**
 * Explains an implicit-`any` checkJs finding that comes from a URL import
 * the per-patch program cannot resolve.
 *
 * The program resolves URL imports only to modules the queue creates (for
 * a test, those created up to its own patch, plus its directory's
 * head.js), so a `resource:///` or `chrome://` import of a module a later
 * patch creates, an upstream module, or a basename two patches create
 * falls back to the shim's `declare module 'resource:*'` wildcard and
 * types as `any`. A callback
 * over its values then has implicitly-`any` parameters under
 * `checkJsStrict`, while the whole-tree `fireforge typecheck`, which sees
 * the module, is clean. Without the note the two disagree with no
 * explanation. A type-member reference through such an import (TS2694 on
 * the wildcard) is dropped instead, so it types as `any` like the whole
 * module. Split out of patch-lint-checkjs.ts for the line budget.
 */

/** Unresolved URL import specifiers, keyed by the importing file's TS path. */
export type AnyTypedImports = Map<string, Set<string>>;

/** TypeScript's implicit-`any` diagnostic codes (noImplicitAny). */
const IMPLICIT_ANY_CODES: ReadonlySet<number> = new Set([
  7005, 7006, 7008, 7010, 7011, 7019, 7031, 7034,
]);

/** TS2694, "Namespace '…' has no exported member '…'". */
const NO_EXPORTED_MEMBER_CODE = 2694;

const NO_EXPORTED_MEMBER = /^Namespace '"([^"]*)"' has no exported member /;

/**
 * True for a type-member reference (`import("…").Type`,
 * `typeof import("…").member`) through an import this program could not
 * resolve. The reference lands on the shim's shorthand `resource:*` /
 * `chrome:*` wildcard (or a consumer's shorthand module of that name),
 * which has no members, so TypeScript reports TS2694 and types the
 * reference as `any`. The finding is dropped: the reference types as `any`
 * here, exactly as a whole-module `typeof import("…")` of the same module
 * does, and the whole-tree `fireforge typecheck` checks it against the
 * real module.
 *
 * @param code - Diagnostic code
 * @param message - Flattened diagnostic message
 * @param specifiers - The file's unresolved URL imports
 */
export function isAnyTypedMemberReference(
  code: number,
  message: string,
  specifiers: ReadonlySet<string> | undefined
): boolean {
  if (code !== NO_EXPORTED_MEMBER_CODE) return false;
  const namespace = NO_EXPORTED_MEMBER.exec(message)?.[1];
  if (namespace === undefined) return false;
  return (
    namespace === 'resource:*' || namespace === 'chrome:*' || specifiers?.has(namespace) === true
  );
}

function recordAnyTypedImport(
  into: Map<string, Set<string>>,
  containingFile: string,
  specifier: string
): void {
  if (!/^(?:resource|chrome):/.test(specifier)) return;
  const list = into.get(containingFile) ?? new Set<string>();
  list.add(specifier);
  into.set(containingFile, list);
}

/**
 * The note an implicit-`any` finding carries when its file imports a
 * `resource://`/`chrome://` module this checkJs program could not resolve.
 * Such an import types as `any` (the shim's wildcard module), so a
 * callback over its values has implicitly-`any` parameters here while the
 * whole-tree `fireforge typecheck`, which sees the module, is clean.
 */
export function anyTypedImportHint(
  code: number,
  specifiers: ReadonlySet<string> | undefined
): string {
  if (!IMPLICIT_ANY_CODES.has(code) || specifiers === undefined || specifiers.size === 0) return '';
  const list = [...specifiers].sort().join(', ');
  return (
    ` (This file imports ${list}, which this per-patch checkJs program cannot resolve — ` +
    'no patch up to this one creates the module under that name: a later patch creates it, ' +
    'it is upstream, or two patches create the same basename — so the import is typed `any`. ' +
    'Annotate the parameter explicitly; the whole-tree "fireforge typecheck" resolves the real type.)'
  );
}

/**
 * The host's `resolveModuleNameLiterals`: owned specifiers first, then a
 * reviewed `paths` mapping, recording every URL import that resolves to
 * neither.
 *
 * @param resolveOwned - Patch-owned specifier resolver
 * @param resolveViaPaths - Optional `paths` resolver
 * @param into - Map that collects the unresolved URL imports
 */
export function createModuleLiteralResolver<Resolved>(
  resolveOwned: (specifier: string) => Resolved | undefined,
  resolveViaPaths: ((specifier: string) => Resolved | undefined) | undefined,
  into: AnyTypedImports
): (
  moduleLiterals: readonly { text: string }[],
  containingFile: string
) => Array<{ resolvedModule: Resolved | undefined }> {
  return (moduleLiterals, containingFile) =>
    moduleLiterals.map((literal) => {
      const owned = resolveOwned(literal.text);
      if (owned) return { resolvedModule: owned };
      const viaPaths = resolveViaPaths?.(literal.text);
      if (viaPaths === undefined) recordAnyTypedImport(into, containingFile, literal.text);
      return { resolvedModule: viaPaths };
    });
}
