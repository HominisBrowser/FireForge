// SPDX-License-Identifier: EUPL-1.2
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';

import { text } from '@clack/prompts';

import { getProjectPaths, loadConfig, mutateConfig, writeConfig } from '../../core/config.js';
import { stdioIsInteractive } from '../../core/destructive.js';
import {
  createDefaultFurnaceConfig,
  furnaceConfigExists,
  writeFurnaceConfig,
} from '../../core/furnace-config.js';
import { DEFAULT_LICENSE } from '../../core/license-headers.js';
import { registerSharedCSS } from '../../core/register-shared-css.js';
import { getTokensCssPath } from '../../core/token-manager.js';
import { generateDefaultTokensCss } from '../../core/token-scaffold.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { ensureDir, pathExists, writeText } from '../../utils/fs.js';
import { cancel, info, intro, isCancel, note, outro, success, warn } from '../../utils/logger.js';
import { normalizePathSlashes } from '../../utils/paths.js';

/**
 * File extensions that are definitely FTL resources (not locale
 * directories). A value ending in one of these is almost certainly the
 * result of the operator pointing at a single FTL file instead of the locale
 * directory that contains it.
 *
 * `furnace init --ftl-base-path browser/<name>.ftl` otherwise produces a
 * misleading success path: the subsequent `furnace create --localized`
 * scaffolds an `.mjs` referencing `insertFTLIfNeeded("<name>.ftl")` while
 * furnace.json has no component entry, leaving the scaffold orphaned.
 * Rejecting file-shaped values up-front keeps the operator on the correct
 * path before any partial state is written.
 */
const FTL_FILE_EXTENSIONS = new Set(['.ftl', '.properties', '.dtd']);

function hasFtlFileExtension(value: string): boolean {
  const lower = value.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  const slashIdx = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  if (dotIdx <= slashIdx) return false; // No extension in the basename.
  return FTL_FILE_EXTENSIONS.has(lower.slice(dotIdx));
}

/**
 * Validates an FTL base path before writing it to furnace.json.
 * Rejects:
 *  - empty values and null bytes
 *  - absolute paths (POSIX or Windows-drive) that escape the engine
 *  - `..` segments that escape the engine
 *  - file-shaped values ending in `.ftl` / `.properties` / `.dtd`
 *    (these are locale resources, not directories, so the operator
 *    almost certainly meant to name the parent directory)
 *
 * When {@link engineDir} is provided and exists on disk, the resolved
 * `engine/${value}` path is probed. If it exists but is not a
 * directory, the same file-shape error fires. If it does not exist yet,
 * a non-blocking warning is logged (a fresh project that has not
 * `fireforge download`-ed yet is the legitimate pre-existence case).
 */
async function validateFtlBasePath(value: string, engineDir?: string): Promise<void> {
  if (value.length === 0) {
    throw new FurnaceError('ftlBasePath must not be empty.');
  }
  if (value.includes('\0')) {
    throw new FurnaceError('ftlBasePath must not contain null bytes.');
  }
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new FurnaceError(
      `ftlBasePath "${value}" must be a relative path inside the engine checkout, not absolute.`
    );
  }
  // Normalize with the POSIX rules regardless of host: `normalize` on Windows
  // emits backslashes, so a `../`-prefix test against the platform `normalize`
  // silently passes every traversal attempt there.
  const normalized = posix.normalize(normalizePathSlashes(value));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new FurnaceError(
      `ftlBasePath "${value}" must not escape the engine checkout via parent-directory segments.`
    );
  }

  if (hasFtlFileExtension(value)) {
    throw new FurnaceError(
      `ftlBasePath "${value}" looks like a file (basename "${basename(value)}" ends in .ftl/.properties/.dtd), but FireForge expects a locale directory such as toolkit/locales/en-US/toolkit/global or browser/locales/en-US/browser. Use the parent directory instead.`
    );
  }

  // Shape probe against the real filesystem when we have an engine
  // directory to anchor against. The probe is best-effort: a missing
  // engine directory or a not-yet-extracted locale tree is
  // legitimate (an operator may `furnace init` before `fireforge
  // download`), so we emit a warning rather than refusing.
  if (engineDir) {
    const resolved = join(engineDir, value);
    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        throw new FurnaceError(
          `ftlBasePath "${value}" resolves to a non-directory at ${resolved}. FireForge expects a locale directory (for example toolkit/locales/en-US/toolkit/global or browser/locales/en-US/browser).`
        );
      }
    } catch (error: unknown) {
      // FurnaceError (from the `isDirectory()` branch above) is a real
      // shape failure, so re-throw and let the operator see it.
      if (error instanceof FurnaceError) throw error;
      // ENOENT is expected on a fresh project before `fireforge
      // download` has populated engine/. Only warn.
      const code = getNodeErrorCode(error);
      if (code === 'ENOENT') {
        warn(
          `ftlBasePath "${value}" does not yet exist at ${resolved}. This is fine if you have not run "fireforge download" yet; rerun "fireforge furnace init --force" after the engine is extracted to re-validate.`
        );
      }
      // Any other stat error is also ignored here as best-effort: a
      // permission issue or malformed engine checkout will surface on
      // the next command that actually reads the FTL tree.
    }
  }
}

/**
 * Runs the furnace init command to create a default furnace.json with
 * user-specified settings.
 * @param projectRoot - Root directory of the project
 * @param options - Init options
 */
export async function furnaceInitCommand(
  projectRoot: string,
  options: { prefix?: string; ftlBasePath?: string; force?: boolean } = {}
): Promise<void> {
  intro('Furnace Init');

  if ((await furnaceConfigExists(projectRoot)) && !options.force) {
    throw new FurnaceError('furnace.json already exists. Use --force to overwrite it.');
  }

  const paths = getProjectPaths(projectRoot);

  // Seed the default furnace config with a tokenPrefix derived from
  // fireforge.json's binaryName so `token coverage` sees real tokens on the
  // very first run. Without the prefix default, a fresh init → token add →
  // coverage sequence reports `0 tokens / N unknown` because the scan has
  // nothing to key off. Loading fireforge.json here is best-effort: a
  // project without one (mid-setup) falls through to the prefix-less
  // default, and `token coverage` emits its existing "no tokenPrefix"
  // warning.
  let derivedBinaryName: string | undefined;
  try {
    const fireForgeConfig = await loadConfig(projectRoot);
    derivedBinaryName = fireForgeConfig.binaryName;
  } catch {
    // Best-effort only: initialising furnace without a fireforge.json is
    // rare but not forbidden. Skip the prefix default in that case.
  }

  const config: FurnaceConfig = createDefaultFurnaceConfig(
    derivedBinaryName ? { binaryName: derivedBinaryName } : {}
  );
  const isInteractive = stdioIsInteractive();
  const engineForValidation = (await pathExists(paths.engine)) ? paths.engine : undefined;

  // Resolve componentPrefix
  if (options.prefix !== undefined) {
    config.componentPrefix = options.prefix;
  } else if (isInteractive) {
    const prefixResult = await text({
      message: 'Component prefix (e.g. "moz-", "ff-")',
      initialValue: config.componentPrefix,
      validate: (value) => {
        if (!value) return 'Prefix is required';
        return undefined;
      },
    });
    if (isCancel(prefixResult)) {
      cancel('Init cancelled');
      return;
    }
    config.componentPrefix = prefixResult;
  }

  // Resolve ftlBasePath
  if (options.ftlBasePath !== undefined) {
    await validateFtlBasePath(options.ftlBasePath, engineForValidation);
    config.ftlBasePath = options.ftlBasePath;
  } else if (isInteractive) {
    const ftlResult = await text({
      message: 'Fluent l10n base path (leave empty for default)',
      placeholder: 'toolkit/locales/en-US/toolkit/global',
    });
    if (isCancel(ftlResult)) {
      cancel('Init cancelled');
      return;
    }
    const ftlValue = ftlResult.trim();
    if (ftlValue) {
      await validateFtlBasePath(ftlValue, engineForValidation);
      config.ftlBasePath = ftlValue;
    }
  }

  await writeFurnaceConfig(projectRoot, config);
  success('Created furnace.json');

  const scaffoldResult = await scaffoldTokensCss(projectRoot);

  const lines: string[] = [`Component prefix: ${config.componentPrefix}`];
  if (config.ftlBasePath) {
    lines.push(`FTL base path: ${config.ftlBasePath}`);
  }
  if (scaffoldResult.tokensCssPath) {
    lines.push(`Tokens CSS:       ${scaffoldResult.tokensCssPath}`);
  }
  note(lines.join('\n'), 'Configuration');

  info(
    'Next steps:\n' +
      '  fireforge furnace scan         — discover engine components\n' +
      '  fireforge furnace create       — create a new custom component\n' +
      '  fireforge furnace override     — fork an existing component\n' +
      '  fireforge token add            — define a token in the scaffolded tokens CSS\n' +
      '  fireforge export <tokens.css>  — capture the tokens CSS + its registration in a patch'
  );

  outro('Init complete');
}

/**
 * Scaffolds the default tokens CSS file under the engine and registers
 * its path in `fireforge.json`'s `patchLint.rawColorAllowlist`. Both
 * operations are skipped silently when the engine directory does not
 * yet exist (a fresh project that hasn't `fireforge download`ed yet).
 * The scaffold is re-driven on the next `furnace init --force`.
 *
 * Returns the scaffolded path when the file was actually created, so
 * the init command can surface it in the summary note.
 */
async function scaffoldTokensCss(projectRoot: string): Promise<{ tokensCssPath?: string }> {
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    info(
      'Skipping tokens CSS scaffold: engine/ not found. Run "fireforge download" followed by "fireforge furnace init --force" to scaffold it.'
    );
    return {};
  }

  let forgeConfig;
  try {
    forgeConfig = await loadConfig(projectRoot);
  } catch (error: unknown) {
    warn(
      `Skipping tokens CSS scaffold: fireforge.json could not be loaded (${toError(error).message}). Re-run "fireforge furnace init --force" after fixing the config.`
    );
    return {};
  }

  const tokensCssPath = getTokensCssPath(forgeConfig.binaryName);
  const tokensCssAbsPath = join(paths.engine, tokensCssPath);

  if (!(await pathExists(tokensCssAbsPath))) {
    try {
      await ensureDir(dirname(tokensCssAbsPath));
      await writeText(
        tokensCssAbsPath,
        generateDefaultTokensCss(forgeConfig.binaryName, forgeConfig.license ?? DEFAULT_LICENSE)
      );
      success(`Scaffolded tokens CSS at engine/${tokensCssPath}`);
    } catch (error: unknown) {
      warn(
        `Could not scaffold tokens CSS at engine/${tokensCssPath}: ${toError(error).message}. Create the file manually before running "fireforge token add".`
      );
      return {};
    }
  } else {
    info(`Tokens CSS already present at engine/${tokensCssPath}; leaving it untouched.`);
  }

  // Registering the tokens file in `patchLint.rawColorAllowlist` is the
  // complement to the scaffold itself: the file exists specifically to carry
  // raw color literals, and without the allowlist entry the first
  // `fireforge lint` after a `token add` fails on raw-color-value issues for
  // tokens the operator just created. The add is idempotent, so re-running
  // `furnace init --force` does not duplicate the entry.
  try {
    const existingAllowlist = forgeConfig.patchLint?.rawColorAllowlist ?? [];
    if (!existingAllowlist.includes(tokensCssPath)) {
      const updatedConfig = mutateConfig(forgeConfig, 'patchLint.rawColorAllowlist', [
        ...existingAllowlist,
        tokensCssPath,
      ]);
      await writeConfig(projectRoot, updatedConfig);
      info(`Added ${tokensCssPath} to patchLint.rawColorAllowlist`);
    }
  } catch (error: unknown) {
    warn(
      `Could not register tokens CSS in patchLint.rawColorAllowlist: ${toError(error).message}. ` +
        `Add "${tokensCssPath}" manually under patchLint.rawColorAllowlist in fireforge.json if lint flags its contents.`
    );
  }

  // Register the tokens CSS in browser/themes/shared/jar.inc.mn so the file
  // is owned end-to-end by tooling. Scaffolding and allowlisting it without
  // registering leaves the very next `fireforge status` correctly flagging
  // it as unmanaged + unregistered while `furnace deploy --dry-run` reports
  // nothing to deploy, a documented init command turning a clean project
  // unclean. The CSS lives at the canonical
  // `browser/themes/shared/<binaryName>-tokens.css` path the shared-CSS rule
  // already targets, so it gets the same
  // `skin/classic/browser/<name>.css (../shared/<name>.css)` entry as any
  // other shared CSS. It is idempotent: `furnace init --force` against a
  // registered tree is a no-op.
  try {
    const fileBase = `${forgeConfig.binaryName}-tokens.css`;
    const result = await registerSharedCSS(paths.engine, fileBase, undefined, false);
    if (!result.skipped) {
      info(`Registered ${fileBase} in browser/themes/shared/jar.inc.mn`);
    }
  } catch (error: unknown) {
    warn(
      `Could not register tokens CSS in browser/themes/shared/jar.inc.mn: ${toError(error).message}. ` +
        `Run "fireforge register browser/themes/shared/${forgeConfig.binaryName}-tokens.css" once jar.inc.mn is reachable.`
    );
  }

  return { tokensCssPath };
}
