// SPDX-License-Identifier: EUPL-1.2
/**
 * What a changed support file selects, and what a named path may be, for the
 * planner: a support file serves the tests beside it under a test directory
 * and the tests whose captured manifest lists it (see `test-manifest-support.ts`).
 */
import { posix } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import {
  classifyNamedPath,
  type ManifestFile,
  notATestMessage,
  supportUsers,
} from '../test-manifest-support.js';
import { isTestPath } from './route.js';
import type { ChangedPath } from './types.js';

/** Under a test directory, where a file is a test's input rather than code. */
const underTestDirectory = (path: string): boolean => /(?:^|\/)(?:test|tests)\//.test(path);

/** Whether an engine path sits under a directory given with its trailing slash. */
const inside =
  (directory: string) =>
  (entry: string): boolean =>
    entry.startsWith(directory);

/**
 * The captured tests each changed support file serves, for the files that serve any.
 *
 * @param changed - What the candidate changed
 * @param tests - The captured tests
 * @param manifests - The captured test manifests
 */
export function servedTests(
  changed: readonly ChangedPath[],
  tests: ReadonlySet<string>,
  manifests: readonly ManifestFile[]
): Map<string, string[]> {
  const served = new Map<string, string[]>();
  for (const change of changed) {
    if (change.deleted || change.tree !== 'engine' || isTestPath(change.path)) continue;
    const listed = supportUsers(change.path, manifests).filter((test) => tests.has(test));
    const beside = underTestDirectory(change.path)
      ? [...tests].filter(inside(`${posix.dirname(change.path)}/`))
      : [];
    const users = [...new Set([...listed, ...beside])].sort();
    if (users.length > 0) served.set(change.path, users);
  }
  return served;
}

/**
 * Refuses a named path a test step cannot run. A test, a manifest and a directory
 * holding captured tests run; a name with no extension is a directory, which may
 * hold tests this capture lacks. A support file's refusal names the tests that read it.
 *
 * @param path - The named path, engine-relative
 * @param tests - The captured tests
 * @param manifests - The captured test manifests
 */
export function assertRunnableNamed(
  path: string,
  tests: ReadonlySet<string>,
  manifests: readonly ManifestFile[]
): void {
  const directory = `${path.replace(/\/+$/, '')}/`;
  if (!/\.[A-Za-z0-9]+$/.test(path) || [...tests].some(inside(directory))) return;
  const kind = classifyNamedPath(path, manifests);
  if (kind.kind === 'test' || kind.kind === 'manifest') return;
  throw new GeneralError(`proof-not-a-test: ${notATestMessage(path, kind)}`);
}

/**
 * The tests changed support files outside test directories select, unless a
 * named or covered test they serve answers for them.
 */
export function servedConsumers(
  changed: readonly ChangedPath[],
  served: ReadonlyMap<string, readonly string[]>,
  answered: readonly string[]
): string[] {
  return changed.flatMap((change) => {
    if (change.route === 'test' || change.deleted) return [];
    const users = served.get(change.path) ?? [];
    return users.some((entry) => answered.includes(entry)) ? [] : [...users];
  });
}
