// SPDX-License-Identifier: EUPL-1.2
/**
 * `token list` and `token show` — the read half of design-token management.
 *
 * `token add` requires `--category` and refuses an unknown one, but nothing
 * reported the categories a project has, so naming one meant hand-parsing a
 * neighbouring `= Category =` banner out of the tokens CSS. Both commands
 * read through `token-inventory.ts`, which is built on the same banner and
 * `:root`-bounds primitives `token add` and `token coverage` use — a second
 * tokens-CSS parser would let the report and the writer disagree about
 * which section a token lives in.
 *
 * Helper module: no registrar, called from `token.ts`.
 */
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  collectTokenBlockValues,
  collectTokenInventory,
  type TokenBlockValue,
  type TokenCategoryInventory,
} from '../core/token-inventory.js';
import { getTokensCssPath } from '../core/token-manager.js';
import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import { info, intro, outro, setMachineOutputMode, setStdoutSealed } from '../utils/logger.js';
import { emitMachineError, MACHINE_OUTPUT_SCHEMA_VERSION } from '../utils/machine-output.js';

/** Reads the project's tokens CSS as lines, refusing when it is absent. */
async function readTokensCssLines(
  projectRoot: string
): Promise<{ lines: string[]; tokensCssPath: string }> {
  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  const tokensCssPath = getTokensCssPath(config.binaryName);
  const filePath = join(paths.engine, tokensCssPath);
  if (!(await pathExists(filePath))) {
    throw new GeneralError(
      `Token CSS file not found: ${tokensCssPath}. Run "fireforge furnace init" to seed it.`
    );
  }
  return { lines: (await readText(filePath)).split('\n'), tokensCssPath };
}

/** Applies the `--category` filter, refusing a name the file does not carry. */
function filterByCategory(
  groups: readonly TokenCategoryInventory[],
  category: string,
  tokensCssPath: string
): TokenCategoryInventory[] {
  const matched = groups.filter((group) => group.category === category);
  if (matched.length > 0) return matched;
  // Same "name the alternatives" contract `token add` gives for an unknown
  // category — a filter that silently prints nothing reads as "this
  // category is empty", which is a different fact.
  const available = groups
    .map((group) => group.category)
    .filter((name): name is string => name !== null);
  const suffix =
    available.length > 0
      ? `Available categories: ${available.map((name) => `"${name}"`).join(', ')}.`
      : 'The file declares no category banners.';
  throw new GeneralError(`Category "${category}" not found in ${tokensCssPath}.\n\n${suffix}`);
}

/** Options accepted by {@link tokenListCommand}. */
export interface TokenListOptions {
  /** Restrict the report to one category. */
  category?: string;
  /** Emit the machine-readable envelope instead of the human report. */
  json?: boolean;
}

/**
 * Lists the categories declared in the tokens CSS with their token names,
 * in file order.
 *
 * @param projectRoot - Root directory of the project
 * @param options - Filter and output-mode options
 */
export async function tokenListCommand(
  projectRoot: string,
  options: TokenListOptions = {}
): Promise<void> {
  if (options.json === true) {
    // stdout belongs exclusively to the payload from here on; a later
    // diagnostic (including withErrorHandling's) routes to stderr.
    setMachineOutputMode(true);
    try {
      const { lines, tokensCssPath } = await readTokensCssLines(projectRoot);
      const all = collectTokenInventory(lines);
      const groups =
        options.category === undefined
          ? all
          : filterByCategory(all, options.category, tokensCssPath);
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
            tokensCssPath,
            categories: groups.map((group) => ({
              category: group.category,
              tokens: group.tokens.map((token) => ({
                name: token.name,
                line: token.line,
                value: token.value,
              })),
            })),
          },
          null,
          2
        )}\n`
      );
      setStdoutSealed(true);
    } catch (error: unknown) {
      emitMachineError('token-list-failed', toError(error).message);
    } finally {
      setMachineOutputMode(false);
    }
    return;
  }

  const { lines, tokensCssPath } = await readTokensCssLines(projectRoot);
  const all = collectTokenInventory(lines);
  const groups =
    options.category === undefined ? all : filterByCategory(all, options.category, tokensCssPath);

  intro('Design Tokens');
  info(tokensCssPath);
  if (groups.length === 0) {
    outro('No token declarations found in the :root block');
    return;
  }
  let total = 0;
  for (const group of groups) {
    info(`  ${group.category ?? '(no category)'} — ${String(group.tokens.length)} token(s)`);
    for (const token of group.tokens) {
      info(`    ${token.name}`);
    }
    total += group.tokens.length;
  }
  outro(`${String(groups.length)} category/categories, ${String(total)} token(s)`);
}

/**
 * Reports one token: the category that owns it and the value it takes in
 * every block that declares it.
 *
 * @param projectRoot - Root directory of the project
 * @param tokenName - Custom-property name, with or without the leading `--`
 * @param options - Output-mode options
 */
export async function tokenShowCommand(
  projectRoot: string,
  tokenName: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const emit = async (): Promise<{
    tokensCssPath: string;
    name: string;
    category: string | null;
    declarations: TokenBlockValue[];
  }> => {
    const { lines, tokensCssPath } = await readTokensCssLines(projectRoot);
    const name = tokenName.startsWith('--') ? tokenName : `--${tokenName}`;
    const declarations = collectTokenBlockValues(lines, name);
    if (declarations.length === 0) {
      throw new GeneralError(
        `Token "${name}" is not declared in ${tokensCssPath}. ` +
          'Run "fireforge token list" to see the declared tokens.'
      );
    }
    const owning = collectTokenInventory(lines).find((group) =>
      group.tokens.some((token) => token.name === name)
    );
    return { tokensCssPath, name, category: owning?.category ?? null, declarations };
  };

  if (options.json === true) {
    setMachineOutputMode(true);
    try {
      const report = await emit();
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION, ...report }, null, 2)}\n`
      );
      setStdoutSealed(true);
    } catch (error: unknown) {
      emitMachineError('token-show-failed', toError(error).message);
    } finally {
      setMachineOutputMode(false);
    }
    return;
  }

  const report = await emit();
  intro('Design Token');
  info(`${report.name} — category: ${report.category ?? '(no category)'}`);
  info(report.tokensCssPath);
  for (const declaration of report.declarations) {
    info(`  ${declaration.block}: ${declaration.value}  (line ${String(declaration.line)})`);
  }
  outro(`${String(report.declarations.length)} declaration(s)`);
}
