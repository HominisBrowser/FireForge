// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-patch lint check for moz.build sorted-list violations (FORGE F2).
 *
 * mozbuild enforces alphabetical ordering on `StrictOrderingOnAppendList`
 * variables and raises `mozbuild.util.UnsortedError: … expected "X" but got
 * "Y"` — but only at CONFIGURE time, i.e. minutes into a `fireforge build`
 * or `fireforge test --build` dispatch. This check reads the patched
 * `moz.build` files from the engine tree (the working tree carries the
 * applied patch state, same as every other per-patch rule) and reports the
 * exact expected/got pair before any build starts.
 */

import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import { pathExists, readText } from '../utils/fs.js';
import { mozbuildSortCompare } from './manifest-helpers.js';

/**
 * moz.build list variables mozbuild declares as `StrictOrderingOnAppendList`
 * (python/mozbuild/mozbuild/frontend/context.py). configure raises
 * `UnsortedError` on append when out of order. `DIRS` is deliberately absent
 * — directory order is meaningful and not strict-ordered. Dotted namespaces
 * (`EXTRA_JS_MODULES.<subdir>`, `EXPORTS.<ns>`) inherit strict ordering
 * from their parent variable.
 */
const STRICT_ORDERED_MOZBUILD_LISTS = [
  'EXTRA_COMPONENTS',
  'EXTRA_JS_MODULES',
  'EXTRA_PP_COMPONENTS',
  'EXPORTS',
  'PYTHON_UNITTEST_MANIFESTS',
  'TESTING_JS_MODULES',
  'XPIDL_SOURCES',
] as const;

const LIST_OPENER = new RegExp(
  `^\\s*((?:${STRICT_ORDERED_MOZBUILD_LISTS.join('|')})(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*\\+?=\\s*\\[`
);

/** One strict-ordered list occurrence: the variable name and its items in file order. */
interface MozBuildListOccurrence {
  varName: string;
  items: string[];
}

/** Extracts every strict-ordered list (with items in file order) from moz.build content. */
function collectStrictOrderedLists(content: string): MozBuildListOccurrence[] {
  const lines = content.split('\n');
  const occurrences: MozBuildListOccurrence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const opener = LIST_OPENER.exec(line);
    if (!opener) continue;

    const varName = opener[1] ?? '';
    const items: string[] = [];
    // Items may start on the opener line (`VAR += ["a", "b"]`) or span
    // following lines until the closing bracket.
    let rest = line.slice(opener[0].length);
    let closed = false;
    for (;;) {
      for (const quoted of rest.matchAll(/["']([^"']+)["']/g)) {
        items.push(quoted[1] ?? '');
      }
      if (/\]/.test(rest)) {
        closed = true;
        break;
      }
      i += 1;
      if (i >= lines.length) break;
      rest = lines[i] ?? '';
      if (/^\s*\]/.test(rest)) {
        closed = true;
        break;
      }
    }
    if (closed) occurrences.push({ varName, items });
  }

  return occurrences;
}

/**
 * Lints the patched content of every `moz.build` file the patch touches for
 * unsorted strict-ordered lists, mirroring mozbuild's `UnsortedError`
 * report: the first index where the list diverges from its sorted copy.
 */
export async function lintMozBuildSortedLists(
  repoDir: string,
  affectedFiles: string[]
): Promise<PatchLintIssue[]> {
  const issues: PatchLintIssue[] = [];

  for (const file of affectedFiles) {
    if (!(file === 'moz.build' || file.endsWith('/moz.build'))) continue;
    const filePath = join(repoDir, file);
    if (!(await pathExists(filePath))) continue;
    const content = await readText(filePath);

    for (const { varName, items } of collectStrictOrderedLists(content)) {
      const sorted = [...items].sort(mozbuildSortCompare);
      const divergence = items.findIndex((item, index) => item !== sorted[index]);
      if (divergence === -1) continue;
      const expected = sorted[divergence] ?? '';
      const got = items[divergence] ?? '';
      issues.push({
        file,
        check: 'mozbuild-unsorted-list',
        fingerprint: `mozbuild-unsorted-list|${file}|${varName}|${expected}|${got}`,
        message:
          `moz.build list ${varName} is not alphabetically sorted: ` +
          `expected "${expected}" but got "${got}" ` +
          '(mozbuild will fail at configure time with UnsortedError)',
        severity: 'error',
      });
    }
  }

  return issues;
}
