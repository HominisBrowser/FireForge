// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { pathExists, readText, writeText } from '../utils/fs.js';

/**
 * Result of normalizing Firefox's Mercurial ignore file for Git-backed
 * checkouts.
 */
export type FirefoxIgnorefileCompatibilityResult = 'created' | 'existing' | 'skipped';

/**
 * Ensures Firefox's mozlint ignorefile configuration can be parsed in
 * Git-backed source trees.
 *
 * Firefox's `tools/lint/ignorefile.yml` includes both `.gitignore` and
 * `.hgignore`. Source archives and some Git mirrors may omit `.hgignore`,
 * which makes `mach lint --fix <files>` fail before it reaches the scoped
 * linter. For FireForge-managed Git checkouts, copying `.gitignore` gives
 * mozlint the missing include and keeps the ignorefile linter's pattern
 * comparison equivalent without patching upstream lint configuration.
 */
export async function ensureFirefoxIgnorefileCompatibility(
  engineDir: string
): Promise<FirefoxIgnorefileCompatibilityResult> {
  const lintConfigPath = join(engineDir, 'tools', 'lint', 'ignorefile.yml');
  if (!(await pathExists(lintConfigPath))) {
    return 'skipped';
  }

  const hgignorePath = join(engineDir, '.hgignore');
  if (await pathExists(hgignorePath)) {
    return 'existing';
  }

  const gitignorePath = join(engineDir, '.gitignore');
  if (!(await pathExists(gitignorePath))) {
    return 'skipped';
  }

  await writeText(hgignorePath, await readText(gitignorePath));
  return 'created';
}
