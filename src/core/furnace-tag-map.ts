// SPDX-License-Identifier: EUPL-1.2
/**
 * Writes `furnace.json#typecheckTagMap`: a generated declaration file that
 * adds each custom component's tag to `HTMLElementTagNameMap`, so
 * `document.createElement("moz-x")` and `querySelector("moz-x")` type as
 * the component's class in a consumer typecheck.
 *
 * An entry is written for every `customElements.define("<tag>", <Class>)`
 * in a custom component's `.mjs` files whose class the module exports
 * (named, or as `default`). Its type is
 * `import("chrome://global/content/elements/<file>.mjs").<export>`, the
 * deployed URL that a `typecheckJsconfig` maps to the workspace source. A
 * `kind: "library"` or `register: false` component, an unexported or
 * inline class, and a customized built-in (`{ extends: … }`) get no entry.
 *
 * Furnace owns the file: it is rewritten whole on deploy and sync, and
 * `furnace validate` reports drift.
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type * as estree from 'estree';

import type { FurnaceConfig } from '../types/furnace.js';
import { pathExists, readText, writeTextIfChanged } from '../utils/fs.js';
import { type AcornESTreeNode, parseModule, walkAST } from './ast-utils.js';
import { getFurnacePaths } from './furnace-config.js';
import { CHROME_ELEMENTS_URL_PREFIX } from './furnace-constants.js';

/** One `HTMLElementTagNameMap` member. */
export interface TagMapEntry {
  /** The element's tag. */
  tag: string;
  /** Deployed module URL the class is imported from. */
  specifier: string;
  /** The class's export name (`default` for a default export). */
  exportName: string;
}

/** Result of a tag-map write or drift check. */
export interface TagMapSyncResult {
  /** The project-relative tag-map file. */
  file: string;
  /** The entries the file declares. */
  entries: TagMapEntry[];
  /** True when the file was (or would be) rewritten. */
  changed: boolean;
}

function isCustomElementsDefine(callee: estree.Node): boolean {
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property.type !== 'Identifier' || callee.property.name !== 'define') return false;
  const object = callee.object;
  if (object.type === 'Identifier') return object.name === 'customElements';
  return (
    object.type === 'MemberExpression' &&
    !object.computed &&
    object.property.type === 'Identifier' &&
    object.property.name === 'customElements'
  );
}

function definesCustomizedBuiltIn(options: estree.Node | undefined): boolean {
  return (
    options?.type === 'ObjectExpression' &&
    options.properties.some(
      (property) =>
        property.type === 'Property' &&
        ((property.key.type === 'Identifier' && property.key.name === 'extends') ||
          (property.key.type === 'Literal' && property.key.value === 'extends'))
    )
  );
}

/** Every `customElements.define("<tag>", <Identifier>)` call: tag → class. */
function collectDefines(program: AcornESTreeNode<estree.Program>): Map<string, string> {
  const defines = new Map<string, string>();
  walkAST(program, {
    enter(node) {
      if (node.type !== 'CallExpression' || !isCustomElementsDefine(node.callee)) return;
      const [tag, cls, options] = node.arguments;
      if (
        tag?.type === 'Literal' &&
        typeof tag.value === 'string' &&
        cls?.type === 'Identifier' &&
        !definesCustomizedBuiltIn(options)
      ) {
        defines.set(tag.value, cls.name);
      }
    },
  });
  return defines;
}

/** Local binding → the name it is exported under, a named export first. */
function collectExports(program: estree.Program): Map<string, string> {
  const named = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      const declaration = statement.declaration;
      if (declaration?.type === 'ClassDeclaration') {
        named.set(declaration.id.name, declaration.id.name);
      }
      if (statement.source) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.local.type !== 'Identifier') continue;
        const exported =
          specifier.exported.type === 'Identifier'
            ? specifier.exported.name
            : String(specifier.exported.value);
        if (!named.has(specifier.local.name)) named.set(specifier.local.name, exported);
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration;
      if (declaration.type === 'ClassDeclaration' && declaration.id) {
        defaults.set(declaration.id.name, 'default');
      } else if (declaration.type === 'Identifier') {
        defaults.set(declaration.name, 'default');
      }
    }
  }
  for (const [local, name] of defaults) {
    if (!named.has(local)) named.set(local, name);
  }
  return named;
}

/**
 * The tag-map entries of one module's source. A source acorn cannot parse
 * contributes none.
 *
 * @param source - Module source
 * @param specifier - The module's deployed URL
 */
function tagMapEntriesForModule(source: string, specifier: string): TagMapEntry[] {
  let program: AcornESTreeNode<estree.Program>;
  try {
    program = parseModule(source);
  } catch {
    return [];
  }
  const exports = collectExports(program);
  const entries: TagMapEntry[] = [];
  for (const [tag, cls] of collectDefines(program)) {
    const exportName = exports.get(cls);
    if (exportName !== undefined) entries.push({ tag, specifier, exportName });
  }
  return entries;
}

/**
 * Collects the tag-map entries of every registered element component,
 * sorted by tag.
 *
 * @param config - Loaded Furnace configuration
 * @param customDir - Absolute custom-components workspace
 */
async function computeTagMapEntries(
  config: FurnaceConfig,
  customDir: string
): Promise<TagMapEntry[]> {
  const entries: TagMapEntry[] = [];
  for (const [name, component] of Object.entries(config.custom)) {
    if (component.kind === 'library' || !component.register) continue;
    const componentDir = join(customDir, name);
    if (!(await pathExists(componentDir))) continue;
    for (const file of (await readdir(componentDir)).sort()) {
      if (!file.endsWith('.mjs')) continue;
      const source = await readText(join(componentDir, file));
      entries.push(...tagMapEntriesForModule(source, `${CHROME_ELEMENTS_URL_PREFIX}${file}`));
    }
  }
  return entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** Renders the generated declaration file. */
function renderTagMap(entries: readonly TagMapEntry[]): string {
  const members = entries.map(
    (entry) =>
      `  ${JSON.stringify(entry.tag)}: import(${JSON.stringify(entry.specifier)})${
        /^[A-Za-z_$][\w$]*$/.test(entry.exportName)
          ? `.${entry.exportName}`
          : `[${JSON.stringify(entry.exportName)}]`
      };`
  );
  return [
    '// Generated by FireForge from furnace.json (typecheckTagMap). Do not edit:',
    '// furnace deploy and furnace sync rewrite it, and furnace validate reports drift.',
    'interface HTMLElementTagNameMap {',
    ...members,
    '}',
    '',
  ].join('\n');
}

/**
 * Writes (or, in dry-run, compares) the configured tag-map file. Returns
 * undefined when `typecheckTagMap` is unset.
 *
 * @param root - Project root directory
 * @param config - Loaded Furnace configuration
 * @param options - `dryRun` reports the difference without writing
 */
export async function syncFurnaceTagMap(
  root: string,
  config: FurnaceConfig,
  options?: { dryRun?: boolean }
): Promise<TagMapSyncResult | undefined> {
  const file = config.typecheckTagMap;
  if (file === undefined) return undefined;
  const entries = await computeTagMapEntries(config, getFurnacePaths(root).customDir);
  const content = renderTagMap(entries);
  const absolute = resolve(root, file);
  const current = (await pathExists(absolute)) ? await readText(absolute) : undefined;
  const changed = current !== content;
  if (changed && options?.dryRun !== true) await writeTextIfChanged(absolute, content);
  return { file, entries, changed };
}
