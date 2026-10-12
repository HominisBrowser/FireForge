// SPDX-License-Identifier: EUPL-1.2
/**
 * Unowned support heads for the named-file checkJs pass of `test --build`.
 *
 * Each named test is checked as its own program: the test plus the
 * patch-owned `head*.js` beside it. A suite moved onto a NEW support head
 * (`head_world_page.js`, loaded with `loadSubScript`) cannot be proven
 * before that head is exported, because the head is in no patch: every kit
 * name reads as "Cannot find name" and the run is refused at preflight,
 * with the generic hint, which offers the shim as a remedy.
 *
 * So an unowned same-directory `head*.js` joins the pass when a named test
 * loads it with `loadSubScript` or a manifest beside it lists it in
 * `support-files`, which are the two ways the harness itself would bring
 * it into the test's scope. The operator is told it is unowned and how to
 * adopt it, as for the `head.js` companions in
 * `patch-lint-unmanaged-companion.ts`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildSupportFileMatcher,
  extractSupportFileEntries,
} from './patch-lint-forward-registration.js';
import { findLoadSubScriptTargets } from './patch-lint-unmanaged-companion.js';

/** A same-directory head no patch owns, and why the pass includes it. */
export interface UnownedSupportHead {
  /** Engine-relative path of the head. */
  file: string;
  /** What brings it into the test's scope. */
  reason: string;
}

const HEAD_BASENAME_PATTERN = /^head(?:_.*)?\.js$/;
const TEST_MANIFEST_PATTERN = /^(?:xpcshell|mochitest|browser|chrome|a11y)\.(?:toml|ini)$/;

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Why `head` is in scope for the named tests of its directory, if it is. */
async function findInclusionReason(
  engineDir: string,
  dir: string,
  head: string,
  context: { tests: readonly string[]; manifests: readonly string[] }
): Promise<string | undefined> {
  const headName = head.slice(dir.length);
  for (const test of context.tests) {
    const source = await readOrUndefined(join(engineDir, test));
    if (source === undefined) continue;
    const loads = findLoadSubScriptTargets(source).some(
      (target) => target.slice(target.lastIndexOf('/') + 1) === headName
    );
    if (loads) return `${test} loads it with loadSubScript`;
  }
  for (const manifest of context.manifests) {
    const source = await readOrUndefined(join(engineDir, manifest));
    if (source === undefined) continue;
    const listed = extractSupportFileEntries(source).some(
      ({ entry }) => buildSupportFileMatcher(manifest, entry)?.(head) === true
    );
    if (listed) return `${manifest} lists it in support-files`;
  }
  return undefined;
}

/**
 * Finds the unowned same-directory `head*.js` files the named tests bring
 * into scope.
 *
 * @param engineDir - Absolute engine directory
 * @param selected - Engine-relative named test files
 * @param owned - Every file the pass already includes
 */
export async function findUnownedSupportHeads(
  engineDir: string,
  selected: Iterable<string>,
  owned: ReadonlySet<string>
): Promise<UnownedSupportHead[]> {
  const testsByDir = new Map<string, string[]>();
  for (const test of selected) {
    const dir = test.slice(0, test.lastIndexOf('/') + 1);
    testsByDir.set(dir, [...(testsByDir.get(dir) ?? []), test]);
  }
  const heads: UnownedSupportHead[] = [];
  for (const [dir, tests] of testsByDir) {
    let names: string[];
    try {
      names = (await readdir(join(engineDir, dir))).sort();
    } catch {
      continue;
    }
    const manifests = names
      .filter((name) => TEST_MANIFEST_PATTERN.test(name))
      .map((name) => `${dir}${name}`);
    const candidates = names
      .filter((name) => HEAD_BASENAME_PATTERN.test(name))
      .map((name) => `${dir}${name}`)
      .filter((file) => !owned.has(file));
    for (const file of candidates) {
      const reason = await findInclusionReason(engineDir, dir, file, { tests, manifests });
      if (reason !== undefined) heads.push({ file, reason });
    }
  }
  return heads;
}

/**
 * The notice for an included unowned head: the ownership fact, the
 * adoption command, and an explicit "not the shim", for the same reason
 * `formatUnmanagedCompanionHint` gives.
 *
 * @param head - From {@link findUnownedSupportHeads}
 */
export function formatUnownedSupportHeadNotice(head: UnownedSupportHead): string {
  return (
    `${head.file} is in no patch yet; the pass includes it because ${head.reason}. ` +
    `Adopt it with "fireforge re-export <patch> --scan --scan-file ${head.file}" before ` +
    'export. Do NOT add its globals to the test shim: that would hide a genuinely missing ' +
    'helper once the head is exported.'
  );
}
