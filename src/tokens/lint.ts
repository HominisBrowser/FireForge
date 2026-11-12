// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural checks over the token system:
 *
 * - `token-lockstep`: a themed block (the dark `@media` mirror, a
 *   `:root[variant]` block) declares only tokens the base `:root` declares;
 *   otherwise every other theme resolves the token to nothing.
 * - `token-undeclared`: a `var(--<prefix>...)` in the token file or an owned
 *   stylesheet names a token nothing declares. Declarations in the same
 *   sheet, in a sibling sheet, and the settings' exempt names do not count
 *   as missing, and neither does a reference with a fallback.
 */
import { cssVarReferences, customProperties, parseCss } from '../syntax/index.js';
import { baseRoot } from './css.js';
import { blockPath, declaredTokens } from './model.js';
import { type OwnedFiles, readTokenFile, type TokenSettings } from './settings.js';
import { siblingSheets } from './siblings.js';

/** One finding. */
export interface TokenLintFinding {
  check: 'token-lockstep' | 'token-undeclared';
  /** Engine-relative file. */
  file: string;
  /** One-based line. */
  line: number;
  token: string;
  message: string;
}

/** What token lint judged. */
export interface TokenLintReport {
  filesScanned: number;
  findings: TokenLintFinding[];
}

/** Themed declarations of prefixed tokens that the base block does not declare. */
function lockstep(file: string, text: string, prefix: string): TokenLintFinding[] {
  const sheet = parseCss(text);
  const root = baseRoot(sheet);
  if (root === undefined) return [];
  const inBase = (line: number): boolean =>
    line >= root.open && (root.close === -1 || line <= root.close);
  const declared = customProperties(sheet);
  const base = new Set(declared.filter((d) => inBase(d.line)).map((d) => d.name));
  return declared
    .filter((d) => !inBase(d.line) && d.name.startsWith(prefix) && !base.has(d.name))
    .map((d) => ({
      check: 'token-lockstep',
      file,
      line: d.line + 1,
      token: d.name,
      message:
        `${d.name} is declared in ${blockPath(d.block)} but not in the base :root block, so every ` +
        'other theme resolves it to nothing. Declare the base value first (fireforge token add), or drop the override.',
    }));
}

/** `var(--<prefix>...)` references to tokens that are not declared anywhere they could come from. */
function undeclared(
  file: string,
  text: string,
  known: ReadonlySet<string>,
  settings: TokenSettings
): TokenLintFinding[] {
  const sheet = parseCss(text);
  const local = new Set(customProperties(sheet).map((d) => d.name));
  const findings: TokenLintFinding[] = [];
  const seen = new Set<string>();
  for (const { name, line, fallback } of cssVarReferences(sheet)) {
    const skip =
      fallback ||
      !name.startsWith(settings.prefix) ||
      known.has(name) ||
      local.has(name) ||
      settings.exempt.has(name) ||
      seen.has(name);
    if (skip) continue;
    seen.add(name);
    findings.push({
      check: 'token-undeclared',
      file,
      line: line + 1,
      token: name,
      message:
        `var(${name}) names a token the token file does not declare, so it resolves to nothing. ` +
        'Add the token, fix the name, or list a runtime channel in furnace.json runtimeVariables.',
    });
  }
  return findings;
}

/**
 * Judges the token file and every owned stylesheet.
 *
 * @param tokenFile - Engine path of the token file
 * @param owned - The project's owned files
 * @param settings - The project's token conventions
 * @throws `token-file-missing`
 */
export async function lintTokens(
  tokenFile: string,
  owned: OwnedFiles,
  settings: TokenSettings
): Promise<TokenLintReport> {
  const tokens = await readTokenFile(owned, tokenFile);
  const known = declaredTokens(tokens);
  const findings = [
    ...lockstep(tokenFile, tokens, settings.prefix),
    ...undeclared(tokenFile, tokens, known, settings),
  ];
  const sheets = owned.paths.filter((path) => path.endsWith('.css') && path !== tokenFile).sort();
  const siblings = await siblingSheets(owned, sheets, settings);
  let filesScanned = 1;
  for (const file of sheets) {
    const text = await owned.read(file);
    if (text === undefined) continue;
    filesScanned++;
    const visible = new Set(known);
    for (const sibling of siblings.get(file) ?? []) {
      for (const name of declaredTokens((await owned.read(sibling)) ?? '')) visible.add(name);
    }
    findings.push(...undeclared(file, text, visible, settings));
  }
  return { filesScanned, findings };
}
