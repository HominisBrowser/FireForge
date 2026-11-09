// SPDX-License-Identifier: EUPL-1.2
/**
 * Answers `git` the way an engine with these changes would, for a suite that
 * pins what changed. The inventory parsing stays real, so a suite cannot drift
 * from how `engine-state.ts` asks.
 */

/** What changed in a pretend engine. */
export interface FakeEngineChanges {
  /** Paths `<anchor>..HEAD` names. */
  committed?: readonly string[];
  /** Tracked paths the working tree modifies. */
  modified?: readonly string[];
  /** Untracked paths. */
  untracked?: readonly string[];
}

/**
 * A `git` implementation for `vi.mocked(git).mockImplementation`.
 *
 * @param changes - What changed
 * @returns Resolves `status` and `diff` from `changes`, anything else to `''`
 */
export function fakeEngineGit(
  changes: FakeEngineChanges = {}
): (args: string[]) => Promise<string> {
  return (args) => {
    if (args.includes('status')) {
      const lines = [
        ...(changes.modified ?? []).map((path) => ` M ${path}`),
        ...(changes.untracked ?? []).map((path) => `?? ${path}`),
      ];
      return Promise.resolve(lines.map((line) => `${line}\0`).join(''));
    }
    if (args.includes('diff')) {
      return Promise.resolve((changes.committed ?? []).map((path) => `${path}\0`).join(''));
    }
    return Promise.resolve('');
  };
}
