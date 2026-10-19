// SPDX-License-Identifier: EUPL-1.2
/**
 * Collects a checkJs program's diagnostics, for every file or for a report
 * scope only. A per-test program resolves the modules its imports reach
 * (see `runCheckJsTestFilesGrouped`), and asking for the whole program's
 * diagnostics would type-check each of those modules once per test, so a
 * scoped run asks only for the files it reports. Split out of
 * patch-lint-checkjs.ts for the line budget.
 */

/**
 * The program's semantic and syntactic diagnostics, limited to the files
 * `reportOnly` names when it is set.
 *
 * @param program - The built program
 * @param relByAbsolute - Owned files: TS path → repo-relative path
 * @param reportOnly - Repo-relative files to collect for, or all when unset
 */
export function collectCheckJsDiagnostics(
  program: import('typescript').Program,
  relByAbsolute: ReadonlyMap<string, string>,
  reportOnly: ReadonlySet<string> | undefined
): import('typescript').Diagnostic[] {
  if (reportOnly === undefined) {
    return [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()];
  }
  return program
    .getSourceFiles()
    .filter((sourceFile) => {
      const rel = relByAbsolute.get(sourceFile.fileName);
      return rel !== undefined && reportOnly.has(rel);
    })
    .flatMap((sourceFile) => [
      ...program.getSemanticDiagnostics(sourceFile),
      ...program.getSyntacticDiagnostics(sourceFile),
    ]);
}
