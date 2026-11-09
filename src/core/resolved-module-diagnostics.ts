// SPDX-License-Identifier: EUPL-1.2
/**
 * Tells a missing-export diagnostic on a module that resolved to a real
 * source file apart from the same code on a module the program could not
 * resolve.
 *
 * TS2305 ("has no exported member") and TS2306 ("is not a module") are in
 * `SUPPRESSED_DIAGNOSTIC_CODES` because a `resource://` or `chrome://`
 * specifier that falls onto the shim's ambient modules cannot be checked.
 * A specifier that resolved to a patch-owned or `paths`-mapped file can be:
 * a removed or renamed export there is a real error whose importers would
 * otherwise type as `any` and fail only at runtime.
 */

/** Codes suppressed for unresolved modules but reported for resolved ones. */
const RESOLVED_MODULE_MEMBER_CODES: ReadonlySet<number> = new Set([2305, 2306]);

/**
 * The module specifier of the import or export declaration that contains
 * `position`, if any.
 */
function moduleSpecifierAt(
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile,
  position: number
): string | undefined {
  for (const statement of sourceFile.statements) {
    if (position < statement.getStart(sourceFile) || position >= statement.end) continue;
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      return statement.moduleSpecifier.text;
    }
    return undefined;
  }
  return undefined;
}

/**
 * True when `diagnostic` is a TS2305/TS2306 raised on an import or export
 * whose specifier `isResolved` reports as resolved to a real file.
 *
 * @param ts - The TypeScript module
 * @param diagnostic - The diagnostic to classify
 * @param isResolved - Whether `specifier`, imported from `containingFile`, resolved to a file
 */
export function isResolvedModuleMemberError(
  ts: typeof import('typescript'),
  diagnostic: import('typescript').Diagnostic,
  isResolved: (containingFile: string, specifier: string) => boolean
): boolean {
  if (!RESOLVED_MODULE_MEMBER_CODES.has(diagnostic.code)) return false;
  const { file, start } = diagnostic;
  if (!file || start === undefined) return false;
  const specifier = moduleSpecifierAt(ts, file, start);
  return specifier !== undefined && isResolved(file.fileName, specifier);
}
