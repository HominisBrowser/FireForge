// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-patch lint check for moz.build sorted-list violations.
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

/**
 * Strips a Python trailing comment from a moz.build line.
 *
 * `#` inside a quoted string is not a comment, so the scan tracks quote state
 * rather than using `indexOf('#')`.
 */
/**
 * True when `line` contains a `]` outside any quoted span. A bracket inside an
 * item (`"icons[2x].png"`) is filename text, not the list's close — reading it
 * as one truncated the item set and left every later item unchecked.
 */
function hasUnquotedCloseBracket(line: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== undefined) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ']') {
      return true;
    }
  }
  return false;
}

function stripMozBuildComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== undefined) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Extracts every strict-ordered list (with items in file order) from moz.build
 * content.
 *
 * Comments are stripped before both the item scan and the close-bracket test.
 * moz.build is Python, and before 0.41.0 neither step knew that:
 *
 * - a quoted string in a trailing comment was scraped in as a phantom list
 *   item (`"Zeta.cpp",  # replaces "Beta.cpp"` yielded a `Beta.cpp` entry), so
 *   the sort check reported an unsorted list naming a file that is not in it —
 *   with a fingerprint that could never stabilise, because the item does not
 *   exist to be moved;
 * - a `]` anywhere in a comment (`# see foo[0]`) closed the list early and
 *   silently truncated the item set.
 *
 * The scan also no longer advances the caller's loop counter: an unterminated
 * list used to consume the rest of the file, so every *later* list in it was
 * skipped entirely.
 *
 * Nor does an unterminated list borrow the NEXT list's bracket. The forward
 * scan stops at the next list opener rather than reading through it: without
 * that, an unclosed `EXTRA_COMPONENTS` swallowed the following
 * `EXTRA_JS_MODULES` — its items merged into the first list's item set and its
 * `]` accepted as the first list's close — reporting a sorting error against a
 * variable that never contained those items, and skipping the second list.
 */
function collectStrictOrderedLists(content: string): MozBuildListOccurrence[] {
  const lines = content.split('\n');
  const occurrences: MozBuildListOccurrence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const opener = LIST_OPENER.exec(lines[i] ?? '');
    if (!opener) continue;

    const varName = opener[1] ?? '';
    const items: string[] = [];
    // Items may start on the opener line (`VAR += ["a", "b"]`) or span
    // following lines until the closing bracket.
    let rest = stripMozBuildComment((lines[i] ?? '').slice(opener[0].length));
    let closed = false;
    // Scan ahead on a local cursor so an unterminated list costs only itself.
    let cursor = i;
    for (;;) {
      // Quote types are matched pairwise so an apostrophe inside a
      // double-quoted item ("don't.cpp") cannot terminate the match early and
      // scrape in a phantom item.
      for (const quoted of rest.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        items.push(quoted[1] ?? quoted[2] ?? '');
      }
      if (hasUnquotedCloseBracket(rest)) {
        closed = true;
        break;
      }
      cursor += 1;
      if (cursor >= lines.length) break;
      rest = stripMozBuildComment(lines[cursor] ?? '');
      if (LIST_OPENER.test(rest)) {
        // A new list starts here, so the previous one never closed. Rewind so
        // the outer loop examines this line as its own opener.
        cursor -= 1;
        break;
      }
      if (/^\s*\]/.test(rest)) {
        closed = true;
        break;
      }
    }
    if (closed) {
      occurrences.push({ varName, items });
      // Resume after the list we just consumed; a list that never closed
      // leaves `i` untouched so the next line is still examined.
      i = cursor;
    }
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
