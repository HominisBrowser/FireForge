// SPDX-License-Identifier: EUPL-1.2
/** What the token commands know about the project's token system, and the files they read. */
import { FireForgeError } from '../kernel/errors.js';
import { type Infer, s } from '../kernel/schema.js';

/** The project's token conventions. */
export interface TokenSettings {
  /** Engine path of the token file. */
  file: string;
  /** Custom-property prefix of the project's tokens, such as `--brand-`. */
  prefix: string;
  /** Custom properties from elsewhere that may be referenced without a declaration. */
  exempt: ReadonlySet<string>;
  /** Prefixes of platform-owned custom properties (`--moz-`). */
  platformPrefixes: readonly string[];
  /** Sheet glob to the sheets (paths or globs) that load beside it, for pairings no link shows. */
  siblingSheets: Readonly<Record<string, readonly string[]>>;
}

/** Files by engine-relative path, for the commands that only read. */
export interface OwnedFiles {
  /** Engine paths the project owns (creates or changes). */
  paths: readonly string[];
  /** A file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
}

/**
 * The engine path of the project's token file: `tokenFile` of the component
 * configuration, else `browser/themes/shared/<binaryName>-tokens.css`.
 *
 * @param binaryName - The project's binary name
 * @param keys - The component configuration, when the project has one
 */
export function tokenFilePath(binaryName: string, keys?: TokenSettingsKeys): string {
  return keys?.tokenFile ?? `browser/themes/shared/${binaryName}-tokens.css`;
}

/**
 * The token file's text.
 *
 * @param files - Where the file lives
 * @param path - Engine path of the token file
 * @throws `token-file-missing`
 */
export async function readTokenFile(
  files: Pick<OwnedFiles, 'read'>,
  path: string
): Promise<string> {
  const text = await files.read(path);
  if (text === undefined) {
    throw new FireForgeError('token-file-missing', `Token file not found: ${path}`, {
      hint: 'Create it with a :root block, or set tokenFile in furnace.json to the file the project uses.',
    });
  }
  return text;
}

const cssVariable = s.string({
  pattern: /^--[\w-]+$/,
  format: 'a custom property such as --x',
});
const relativePath = s.string({
  pattern: /^(?!\/)(?![A-Za-z]:)(?!.*\.\.)[^\0\\]+$/,
  format: 'a relative path without ".." or backslashes',
});

/**
 * The token keys of the component configuration (`furnace.json`), for its
 * schema to spread in: this is their one declaration.
 */
export const tokenSettingsKeys = {
  tokenFile: relativePath
    .describe(
      'Engine path of the token file (default browser/themes/shared/<binaryName>-tokens.css)'
    )
    .optional(),
  tokenPrefix: s
    .string({ min: 1 })
    .describe('Custom-property prefix of the project tokens, such as --brand-')
    .optional(),
  tokenAllowlist: s
    .array(cssVariable)
    .describe('Custom properties from elsewhere that stylesheets may reference')
    .optional(),
  platformPrefixes: s
    .array(s.string({ min: 1 }))
    .describe('Prefixes of platform-owned custom properties')
    .optional(),
  runtimeVariables: s
    .array(cssVariable)
    .describe('Runtime state channels set from script')
    .optional(),
  tokenHostDocuments: s
    .array(relativePath)
    .describe('Documents that load the token file')
    .optional(),
  tokenSiblingSheets: s
    .record(s.array(relativePath, { min: 1 }))
    .describe('Sheet glob to the sheets that load beside it')
    .optional(),
};

/** The token keys as the component configuration holds them. */
export type TokenSettingsKeys = Partial<{
  [K in keyof typeof tokenSettingsKeys]: Infer<(typeof tokenSettingsKeys)[K]>;
}>;

/**
 * The project's token conventions, from the token keys of its component
 * configuration, falling back to the prefix `--<binaryName>-`.
 *
 * @param keys - The component configuration, or undefined when the project has none
 * @param binaryName - The project's binary name
 */
export function tokenSettings(
  keys: TokenSettingsKeys | undefined,
  binaryName: string
): TokenSettings {
  return {
    file: tokenFilePath(binaryName, keys),
    prefix: keys?.tokenPrefix ?? `--${binaryName}-`,
    exempt: new Set([...(keys?.tokenAllowlist ?? []), ...(keys?.runtimeVariables ?? [])]),
    platformPrefixes: keys?.platformPrefixes ?? ['--moz-'],
    siblingSheets: keys?.tokenSiblingSheets ?? {},
  };
}
