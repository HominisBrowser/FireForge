// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace.json`: the component configuration. It names every component the
 * project carries (custom widgets, overrides of stock widgets, stock widgets
 * it composes), where each deploys, the validation policy, and the typing
 * files Furnace generates. The token keys are declared by the `tokens` module.
 *
 * Edits go through the raw document, never the parsed configuration, so a
 * default the schema fills in is never written back, and only the changed
 * values are rewritten.
 */
import { join, posix } from 'node:path';

import type { FireForgeConfig } from '../config/index.js';
import { type ErrorDetails, ExitCode, FireForgeError } from '../kernel/errors.js';
import { readTextIfExists } from '../kernel/fs.js';
import type { Transaction } from '../kernel/journal.js';
import { isRecord, type JsonObject, parseJson, stringifyJson } from '../kernel/json.js';
import { editJsonText } from '../kernel/json-edit.js';
import { type Infer, s } from '../kernel/schema.js';
import type { ProjectPaths } from '../project/index.js';
import { tokenSettingsKeys } from '../tokens/index.js';

/** What Furnace needs of a project: its locations and its configuration. */
export interface FurnaceProject {
  readonly paths: ProjectPaths;
  readonly config: FireForgeConfig;
}

/** A component's place in `furnace.json`. */
export type ComponentKind = 'custom' | 'override';

/** Checks that run only when `optInChecks` names them. */
const OPT_IN_CHECKS = ['icon-button-label'] as const;

/** The engine file every registered custom element is listed in. */
export const CUSTOM_ELEMENTS_JS = 'toolkit/content/customElements.js';
/** The jar manifest that packages component files. */
export const WIDGETS_JAR = 'toolkit/content/jar.mn';
/** Where a new custom component deploys, below which each component has its directory. */
export const WIDGETS_DIR = 'toolkit/content/widgets';
/** The chrome URL a component's modules and stylesheets are packaged under. */
export const ELEMENTS_URL = 'chrome://global/content/elements/';
const DEFAULT_FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

/** A custom element name: lowercase letters and digits in at least two hyphen-joined groups. */
const TAG = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const NAME = s.string({
  pattern: TAG,
  format: 'a custom element name such as moz-my-widget',
});
const RELATIVE_PATH = s.string({
  pattern: /^(?!\/)(?![A-Za-z]:)(?!.*\.\.)[^\0\\]+$/,
  format: 'a relative path without ".." or backslashes',
});
const NON_EMPTY = s.string({ pattern: /\S/, format: 'a non-empty string' });

const overrideSchema = s.object({
  type: s.enum(['css-only', 'full']).describe('css-only deploys only stylesheets'),
  description: s.string(),
  basePath: RELATIVE_PATH.describe('Engine directory the stock component lives in'),
  baseVersion: s.string().describe('Firefox version the override was taken from'),
  baseCommit: s.string().optional(),
});

const customSchema = s
  .object({
    description: s.string(),
    targetPath: RELATIVE_PATH.describe('Engine directory the component deploys into'),
    register: s.boolean().describe('List the element in customElements.js'),
    localized: s.boolean().describe('The component uses Fluent strings'),
    kind: s
      .enum(['element', 'library'])
      .describe('library: base classes and helpers, no element of its own')
      .optional(),
    composes: s.array(NAME).describe('Components it renders inside its template').optional(),
    keyboardCovered: s
      .boolean()
      .describe('Keyboard activation comes from a wrapped native element')
      .optional(),
    sharedFtl: s
      .string({
        pattern: /^(?!\s)(?!.*\$\{)[^`\\]*\S$/,
        format: 'a Fluent path without backticks, backslashes or ${',
      })
      .describe('An existing feature Fluent file the component shares instead of its own')
      .optional(),
  })
  .refine((entry) => {
    if (entry.kind === 'library' && entry.register) {
      return 'is a library, which defines no element: set register to false';
    }
    if (entry.sharedFtl !== undefined && !entry.localized) {
      return 'has sharedFtl, which requires localized: true';
    }
    return undefined;
  });

const exceptionSchema = s
  .object({
    component: NON_EMPTY,
    check: NON_EMPTY,
    reason: NON_EMPTY.describe('The review record'),
    tag: NON_EMPTY.describe('Only findings about this element tag').optional(),
    file: s
      .string({ pattern: /^(?!\.\.?$)[^/\\]+$/, format: 'a file name of the component' })
      .describe('Only findings in this module of the component')
      .optional(),
  })
  .refine((entry) =>
    entry.tag !== undefined && entry.file !== undefined
      ? 'may name a tag or a file, not both'
      : undefined
  );

/** The `furnace.json` schema. */
const furnaceSchema = s
  .object({
    version: s.literal(1).default(1),
    componentPrefix: s.string().describe('Prefix every custom component name starts with'),
    stock: s.array(NAME).describe('Stock components the project composes').default([]),
    overrides: s.record(overrideSchema, { key: NAME }).default({}),
    custom: s.record(customSchema, { key: NAME }).default({}),
    ftlBasePath: RELATIVE_PATH.describe(
      'Engine directory localized components deploy into'
    ).optional(),
    typecheckJsconfig: s
      .union(RELATIVE_PATH, s.array(RELATIVE_PATH, { min: 1 }))
      .describe('jsconfig files whose chrome-module paths Furnace maintains')
      .optional(),
    typecheckTagMap: s
      .string({
        pattern: /^(?!\/)(?!.*\.\.)[^\0\\]+\.d\.ts$/,
        format: 'a relative ".d.ts" path without ".."',
      })
      .describe('Declaration file Furnace writes with the HTMLElementTagNameMap entries')
      .optional(),
    validationExceptions: s.array(exceptionSchema).optional(),
    minComponents: s
      .int({ min: 1 })
      .describe('Fewest components a full validation judges')
      .optional(),
    optInChecks: s.array(s.enum(OPT_IN_CHECKS)).optional(),
    ...tokenSettingsKeys,
  })
  .refine(configProblem);

/** A validated `furnace.json`, defaults applied. */
export type FurnaceConfig = Infer<typeof furnaceSchema>;
/** One custom component's entry. */
export type CustomComponent = FurnaceConfig['custom'][string];
/** One override's entry. */
export type OverrideComponent = FurnaceConfig['overrides'][string];
/** One reviewed validation finding. */
export type ValidationException = NonNullable<FurnaceConfig['validationExceptions']>[number];

/** Cross-entry rules: names unique across sections, composes known and acyclic. */
function configProblem(config: FurnaceConfig): string | undefined {
  const seen = new Set<string>();
  for (const name of [...config.stock, ...Object.keys(config.overrides)]) {
    if (seen.has(name)) return `names "${name}" twice in stock and overrides`;
    seen.add(name);
  }
  for (const name of Object.keys(config.custom)) {
    if (seen.has(name)) return `names "${name}" both as custom and as stock or override`;
    seen.add(name);
  }
  for (const [name, entry] of Object.entries(config.custom)) {
    const unknown = entry.composes?.find((ref) => !seen.has(ref));
    if (unknown !== undefined) return `custom "${name}" composes unknown component "${unknown}"`;
  }
  const cycle = composesCycle(config.custom);
  if (cycle !== undefined) return `has a composes cycle: ${cycle.join(' -> ')}`;
  const exceptions = new Set<string>();
  for (const entry of config.validationExceptions ?? []) {
    const key = [entry.component, entry.check, entry.tag ?? '', entry.file ?? ''].join('\0');
    if (exceptions.has(key)) {
      return `repeats the validation exception for ${entry.component} [${entry.check}]`;
    }
    exceptions.add(key);
  }
  return undefined;
}

function composesCycle(custom: FurnaceConfig['custom']): string[] | undefined {
  const done = new Set<string>();
  const visit = (name: string, path: string[]): string[] | undefined => {
    if (path.includes(name)) return [...path.slice(path.indexOf(name)), name];
    if (done.has(name)) return undefined;
    for (const ref of custom[name]?.composes ?? []) {
      if (ref in custom) {
        const found = visit(ref, [...path, name]);
        if (found !== undefined) return found;
      }
    }
    done.add(name);
    return undefined;
  };
  for (const name of Object.keys(custom)) {
    const found = visit(name, []);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A failure of component management (exit code 9).
 *
 * @param code - The stable error code
 * @param message - What went wrong
 * @param details - The hint and cause
 */
export function furnaceError(
  code: string,
  message: string,
  details: Omit<ErrorDetails, 'exitCode'> = {}
): FireForgeError {
  return new FireForgeError(code, message, { exitCode: ExitCode.FURNACE_ERROR, ...details });
}

/** A loaded `furnace.json`: the configuration and the document as written. */
interface FurnaceDocument {
  config: FurnaceConfig;
  /** The raw document, for edits. */
  document: JsonObject;
  /** The file's text, or undefined when the file does not exist yet. */
  text: string | undefined;
}

const invalid = (path: string): ErrorDetails & { code: string; source: string } => ({
  code: 'furnace-config-invalid',
  exitCode: ExitCode.CONFIG_ERROR,
  hint: `Fix ${path}; docs/furnace.md describes its keys.`,
  source: path,
});

/**
 * The configuration of a document, validated.
 *
 * @param document - The raw document
 * @param source - The file, for messages
 * @throws `furnace-config-invalid` (exit code 2), naming every key at fault
 */
export function parseFurnaceConfig(document: unknown, source: string): FurnaceConfig {
  return furnaceSchema.parse(document, invalid(source));
}

/**
 * Reads `furnace.json`.
 *
 * @param project - The project
 * @returns The document, or undefined when the project has no `furnace.json`
 * @throws `furnace-config-invalid` (exit code 2) for a file that does not parse or validate
 */
async function readFurnaceDocument(project: FurnaceProject): Promise<FurnaceDocument | undefined> {
  const path = project.paths.furnace;
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  const document = parseJson(text, invalid(path));
  if (!isRecord(document)) {
    throw new FireForgeError('furnace-config-invalid', `${path} must hold a JSON object`, {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Restore furnace.json from version control, or delete it and add the components again with "fireforge furnace create".',
    });
  }
  return { config: parseFurnaceConfig(document, path), document, text };
}

/**
 * Loads `furnace.json`; a project without one has no components.
 *
 * @param project - The project
 * @throws `furnace-config-invalid` (exit code 2)
 */
export async function loadFurnaceConfig(project: FurnaceProject): Promise<FurnaceConfig> {
  return (await readFurnaceDocument(project))?.config ?? emptyConfig();
}

/** The configuration a project starts with. */
function emptyConfig(): FurnaceConfig {
  return parseFurnaceConfig({ version: 1, componentPrefix: 'moz-' }, 'the default furnace.json');
}

/**
 * Edits `furnace.json` inside a transaction: `edit` changes the raw document
 * (created with the defaults when the file is absent; a key set to
 * undefined is removed), the result is validated, and only the changed
 * values are rewritten.
 *
 * @param project - The project
 * @param tx - The transaction the write joins
 * @param edit - Changes the document in place
 * @returns The configuration after the edit
 */
export async function editFurnaceConfig(
  project: FurnaceProject,
  tx: Transaction,
  edit: (document: JsonObject) => void
): Promise<FurnaceConfig> {
  const current = await readFurnaceDocument(project);
  const document: JsonObject = structuredClone(
    current?.document ?? { version: 1, componentPrefix: 'moz-', custom: {} }
  );
  edit(document);
  const config = parseFurnaceConfig(parseJson(stringifyJson(document)), project.paths.furnace);
  const text =
    (current?.text === undefined ? undefined : editJsonText(current.text, document)) ??
    stringifyJson(document);
  if (text !== current?.text) await tx.write(project.paths.furnace, text);
  return config;
}

/**
 * The object at `key` of a document, created when absent.
 *
 * @param document - The raw document
 * @param key - A top-level key holding an object (`custom`, `overrides`)
 */
export function section(document: JsonObject, key: string): JsonObject {
  const value = document[key];
  if (isRecord(value)) return value;
  const created: JsonObject = {};
  document[key] = created;
  return created;
}

/** The directory of a component's sources in the project. */
export function componentDir(project: FurnaceProject, kind: ComponentKind, name: string): string {
  return join(project.paths.components, kind === 'custom' ? 'custom' : 'overrides', name);
}

/** The directory shared CSS fragments live in. */
export function fragmentsDir(project: FurnaceProject): string {
  return join(project.paths.components, 'shared');
}

/** The engine directory a component's `.ftl` deploys into. */
export function ftlDir(config: FurnaceConfig): string {
  return config.ftlBasePath ?? DEFAULT_FTL_DIR;
}

/**
 * The resource path a localized component loads its own `.ftl` by: the
 * Fluent directory below its `locales/<locale>/` segment.
 *
 * @param config - The configuration
 */
export function ftlResourceDir(config: FurnaceConfig): string | undefined {
  return /^.*?\/locales\/[^/]+\/(.+?)\/?$/.exec(ftlDir(config))?.[1];
}

/**
 * The engine paths of the files `furnace validate` judges for raw colours,
 * token prefixes and relative imports: each component's host module and
 * stylesheet where it deploys them.
 *
 * @param config - The configuration
 */
export function componentHostFiles(config: FurnaceConfig): string[] {
  const hosts = (dir: string, name: string): string[] => [
    `${dir}/${name}.mjs`,
    `${dir}/${name}.css`,
  ];
  return [
    ...Object.entries(config.custom).flatMap(([name, entry]) => hosts(entry.targetPath, name)),
    ...Object.entries(config.overrides).flatMap(([name, entry]) => hosts(entry.basePath, name)),
  ];
}

/** The jar.mn source directory of a custom component, relative to `toolkit/content`. */
export function jarSourceDir(targetPath: string): string {
  return posix.relative(posix.dirname(WIDGETS_JAR), targetPath);
}

/** The typing files `typecheckJsconfig` names. */
export function jsconfigPaths(config: FurnaceConfig): string[] {
  const value = config.typecheckJsconfig;
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

/**
 * Why a name cannot be a custom element tag, or undefined when it can.
 *
 * @param name - The candidate
 */
export function tagProblem(name: string): string | undefined {
  return TAG.test(name)
    ? undefined
    : `"${name}" is not a custom element name: lowercase letters and digits in groups joined by single hyphens, at least two groups (such as "moz-my-widget").`;
}

/** The class name of a tag: `moz-sidebar-panel` is `MozSidebarPanel`. */
export function className(tag: string): string {
  return tag
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** A component of the configuration, located. */
export interface ComponentRef {
  name: string;
  kind: ComponentKind;
}

/** Every override and custom component, overrides first. */
export function components(config: FurnaceConfig): ComponentRef[] {
  return [
    ...Object.keys(config.overrides).map((name) => ({ name, kind: 'override' as const })),
    ...Object.keys(config.custom).map((name) => ({ name, kind: 'custom' as const })),
  ];
}

/**
 * The component of that name.
 *
 * @param config - The configuration
 * @param name - The component
 * @throws `furnace-unknown-component` (exit code 8) when it is not an override or custom component
 */
export function findComponent(config: FurnaceConfig, name: string): ComponentRef {
  const found = components(config).find((component) => component.name === name);
  if (found !== undefined) return found;
  throw new FireForgeError(
    'furnace-unknown-component',
    `furnace.json has no component "${name}".`,
    {
      exitCode: ExitCode.INVALID_ARGUMENT,
      hint: 'Run "fireforge furnace status" to list the components.',
    }
  );
}
