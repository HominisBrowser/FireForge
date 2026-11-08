// SPDX-License-Identifier: EUPL-1.2
import { devNull } from 'node:os';

/**
 * Configuration FireForge pins on every Git invocation it makes.
 *
 * Engine baselines and generated patches must be byte-identical whoever runs
 * them, so nothing the operator configured globally may change which files are
 * indexed (`core.excludesFile`, the XDG ignore file) or how a diff is rendered
 * (prefixes, colour, rename detection, algorithm). Hooks and
 * commit signing are off because FireForge's own commits are mechanical and
 * run over hundreds of thousands of files.
 *
 * Repository-local configuration (`.git/config`, `.git/info/exclude`) still
 * applies: FireForge writes the engine's identity and line-ending policy there.
 */
const PINNED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', devNull],
  ['core.attributesFile', devNull],
  ['core.excludesFile', devNull],
  ['uploadpack.packObjectsHook', ''],
  ['diff.noprefix', 'false'],
  ['diff.mnemonicPrefix', 'false'],
  ['diff.renames', 'true'],
  ['diff.algorithm', 'myers'],
  ['diff.colorMoved', 'false'],
  ['color.ui', 'false'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
];

/**
 * Inherited variables that would re-introduce operator configuration after
 * the pinned set (`GIT_CONFIG_PARAMETERS` carries an outer `git -c`).
 */
export const HERMETIC_GIT_ENV_UNSET: readonly string[] = [
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
];

/**
 * The one Git environment shared by every FireForge Git call, admitted jobs
 * included. The process's own repository-selecting variables
 * (`GIT_DIR`, `GIT_INDEX_FILE`) are left to the caller.
 */
export function hermeticGitEnvironment(execPath?: string): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: String(PINNED_CONFIG.length),
  };
  for (const [index, [key, value]] of PINNED_CONFIG.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  if (execPath !== undefined) env['GIT_EXEC_PATH'] = execPath;
  return env;
}
