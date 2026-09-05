// SPDX-License-Identifier: EUPL-1.2
/**
 * Environment construction for spawned children.
 *
 * Its own module rather than a helper inside `process.ts` only because that
 * file sits on a 500-line budget. The logic belongs to the exec layer.
 */

/** The `env` / `envUnset` slice of exec options this module needs. */
interface ChildEnvOptions {
  /** Variables to add or overwrite on top of `process.env`. */
  env?: Record<string, string> | undefined;
  /** Variables to remove after the merge. */
  envUnset?: readonly string[] | undefined;
}

/**
 * The child's environment: `process.env`, with `env` merged over it, then
 * every `envUnset` key removed.
 *
 * One helper rather than five inline spreads: the removal step is easy to
 * add at four of the five spawn sites and forget at the fifth, which would
 * make the option silently inert exactly where it was not tested.
 *
 * Removal is a real removal rather than an assignment to `''`: mozbuild's
 * `is_running_under_coding_agent()` reads `CLAUDECODE` only for its
 * presence, so an empty value would not unset it. `Reflect.deleteProperty` rather than
 * `delete obj[key]` because the key is computed.
 *
 * @param options - Options carrying `env` / `envUnset`
 * @returns The environment to hand `spawn`
 */
export function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const key of options.envUnset ?? []) {
    Reflect.deleteProperty(merged, key);
  }
  return merged;
}
