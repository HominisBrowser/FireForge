// SPDX-License-Identifier: EUPL-1.2
/**
 * The typing files Furnace generates from the components, so code that
 * imports a component module or creates its element is typed:
 *
 * - `typecheckJsconfig`: in each named jsconfig, a `compilerOptions.paths`
 *   entry per component module, mapping its chrome URL to the source in
 *   `components/custom/`. Furnace manages only entries under the elements
 *   URL that point into `components/custom/`; every other entry is the
 *   jsconfig owner's and is kept.
 * - `typecheckTagMap`: a declaration adding each registered element whose
 *   module exports its class to `HTMLElementTagNameMap`. Furnace owns the
 *   whole file.
 *
 * A path starting `engine/` names the project's tracked copy of that engine
 * file; any other path is relative to the project root.
 */
import { dirname, join, relative, resolve } from 'node:path';

import type * as estree from 'estree';

import { isInside, listDir, readTextIfExists, toPosixPath } from '../kernel/fs.js';
import type { Transaction } from '../kernel/journal.js';
import { isRecord, type JsonObject, parseJson } from '../kernel/json.js';
import { editJsonText } from '../kernel/json-edit.js';
import { configuredPath, type TrackedFiles } from '../project/index.js';
import { isStringLiteral, parseJs, walkJs } from '../syntax/index.js';
import {
  componentDir,
  ELEMENTS_URL,
  type FurnaceConfig,
  furnaceError,
  type FurnaceProject,
  jsconfigPaths,
} from './config.js';

/** One generated typing file whose content is not what the components want. */
export type TypingDrift = {
  /** The path as `furnace.json` names it. */
  file: string;
  /** What differs. */
  detail: string;
};

interface TypingFile {
  file: string;
  absolute: string;
  current: string | undefined;
  next: string;
  detail: string;
}

async function locate(
  project: FurnaceProject,
  tracked: TrackedFiles,
  file: string
): Promise<{ absolute: string; current: string | undefined }> {
  const named = configuredPath(file);
  if (named.tree === 'engine') {
    return { absolute: tracked.locate(named.path), current: await tracked.read(named.path) };
  }
  const absolute = join(project.paths.root, named.path);
  return { absolute, current: await readTextIfExists(absolute) };
}

/** The `.mjs` files of each custom component, by component. */
async function componentModules(
  project: FurnaceProject,
  config: FurnaceConfig,
  include: (name: string) => boolean
): Promise<{ name: string; dir: string; files: string[] }[]> {
  const modules = [];
  for (const name of Object.keys(config.custom).filter(include)) {
    const dir = componentDir(project, 'custom', name);
    const files = (await listDir(dir))
      .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.mjs'))
      .map((entry) => entry.name);
    modules.push({ name, dir, files });
  }
  return modules;
}

async function jsconfigFile(
  project: FurnaceProject,
  config: FurnaceConfig,
  tracked: TrackedFiles,
  file: string
): Promise<TypingFile> {
  const { absolute, current } = await locate(project, tracked, file);
  const document = current === undefined ? undefined : parseJson(current, { source: file });
  if (current === undefined || !isRecord(document)) {
    throw furnaceError(
      'furnace-jsconfig-invalid',
      `furnace.json "typecheckJsconfig" names ${file}, which ${current === undefined ? 'does not exist' : 'is not a JSON object'}.`,
      {
        hint: 'Create the jsconfig (Furnace maintains only its component paths), or remove the setting.',
      }
    );
  }
  const base = dirname(absolute);
  const customRoot = join(project.paths.components, 'custom');
  const wanted = new Map<string, string>();
  for (const { dir, files } of await componentModules(project, config, () => true)) {
    for (const name of files) {
      const path = toPosixPath(relative(base, join(dir, name)));
      wanted.set(`${ELEMENTS_URL}${name}`, path.startsWith('.') ? path : `./${path}`);
    }
  }
  const options = isRecord(document['compilerOptions']) ? document['compilerOptions'] : {};
  const paths = isRecord(options['paths']) ? options['paths'] : {};
  const next: JsonObject = {};
  const changes: string[] = [];
  for (const [key, value] of Object.entries(paths)) {
    const target = Array.isArray(value) && value.length === 1 ? value[0] : undefined;
    const managed =
      key.startsWith(ELEMENTS_URL) &&
      typeof target === 'string' &&
      isInside(customRoot, resolve(base, target)) &&
      resolve(base, target) !== customRoot;
    const want = wanted.get(key);
    if (!managed || want === undefined) {
      if (managed) changes.push(`orphaned ${key}`);
      else next[key] = value;
      continue;
    }
    const same = resolve(base, target) === resolve(base, want);
    if (!same) changes.push(`stale ${key}`);
    next[key] = same ? value : [want];
  }
  for (const [key, want] of wanted) {
    if (next[key] !== undefined) continue;
    next[key] = [want];
    changes.push(`missing ${key}`);
  }
  if (changes.length === 0) return { file, absolute, current, next: current, detail: '' };
  const edited: JsonObject = { ...document, compilerOptions: { ...options, paths: next } };
  const text = editJsonText(current, edited);
  if (text === undefined) {
    throw furnaceError('furnace-jsconfig-invalid', `${file} could not be edited in place.`);
  }
  return { file, absolute, current, next: text, detail: changes.join('; ') };
}

/** `customElements.define("tag", Class)` calls of a module, autonomous elements only. */
function definedElements(program: estree.Program): Map<string, string> {
  const defined = new Map<string, string>();
  walkJs(program, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const { object, property } = node.callee;
    const receiver =
      object.type === 'Identifier'
        ? object.name
        : object.type === 'MemberExpression' && object.property.type === 'Identifier'
          ? object.property.name
          : undefined;
    if (
      receiver !== 'customElements' ||
      property.type !== 'Identifier' ||
      property.name !== 'define'
    ) {
      return;
    }
    const [tag, cls, options] = node.arguments;
    const builtIn =
      options?.type === 'ObjectExpression' &&
      options.properties.some(
        (entry) =>
          entry.type === 'Property' &&
          ((entry.key.type === 'Identifier' && entry.key.name === 'extends') ||
            (entry.key.type === 'Literal' && entry.key.value === 'extends'))
      );
    if (isStringLiteral(tag) && cls?.type === 'Identifier' && !builtIn) {
      defined.set(tag.value, cls.name);
    }
  });
  return defined;
}

/** The name each exported local binding is exported under; a named export wins over `default`. */
function exportedNames(program: estree.Program): Map<string, string> {
  const named = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.source == null) {
      if (statement.declaration?.type === 'ClassDeclaration') {
        named.set(statement.declaration.id.name, statement.declaration.id.name);
      }
      for (const specifier of statement.specifiers) {
        if (specifier.local.type !== 'Identifier' || named.has(specifier.local.name)) continue;
        const exported = specifier.exported;
        named.set(
          specifier.local.name,
          exported.type === 'Identifier' ? exported.name : String(exported.value)
        );
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration;
      const local =
        declaration.type === 'ClassDeclaration'
          ? declaration.id?.name
          : declaration.type === 'Identifier'
            ? declaration.name
            : undefined;
      if (local !== undefined) defaults.set(local, 'default');
    }
  }
  for (const [local, name] of defaults) if (!named.has(local)) named.set(local, name);
  return named;
}

/** One `HTMLElementTagNameMap` member. */
interface TagEntry {
  tag: string;
  module: string;
  exportName: string;
}

async function tagMapEntries(project: FurnaceProject, config: FurnaceConfig): Promise<TagEntry[]> {
  const entries: TagEntry[] = [];
  const registered = (name: string): boolean => {
    const entry = config.custom[name];
    return entry !== undefined && entry.register && entry.kind !== 'library';
  };
  for (const { dir, files } of await componentModules(project, config, registered)) {
    for (const file of files) {
      const source = await readTextIfExists(join(dir, file));
      let program: estree.Program;
      try {
        program = parseJs(source ?? '', 'module').program;
      } catch {
        continue; // A module that does not parse is validation's finding, not a typing entry.
      }
      const exported = exportedNames(program);
      for (const [tag, cls] of definedElements(program)) {
        const exportName = exported.get(cls);
        if (exportName !== undefined)
          entries.push({ tag, module: `${ELEMENTS_URL}${file}`, exportName });
      }
    }
  }
  return entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

function renderTagMap(entries: readonly TagEntry[]): string {
  const members = entries.map((entry) => {
    const member = /^[A-Za-z_$][\w$]*$/.test(entry.exportName)
      ? `.${entry.exportName}`
      : `[${JSON.stringify(entry.exportName)}]`;
    return `  ${JSON.stringify(entry.tag)}: HTMLElement & import(${JSON.stringify(entry.module)})${member};`;
  });
  return [
    '// Generated by FireForge from furnace.json (typecheckTagMap). Do not edit:',
    '// fireforge furnace types rewrites it, and furnace validate reports drift.',
    'interface HTMLElementTagNameMap {',
    ...members,
    '}',
    '',
  ].join('\n');
}

async function typingFiles(
  project: FurnaceProject,
  config: FurnaceConfig,
  tracked: TrackedFiles
): Promise<TypingFile[]> {
  const files: TypingFile[] = [];
  for (const file of jsconfigPaths(config))
    files.push(await jsconfigFile(project, config, tracked, file));
  if (config.typecheckTagMap !== undefined) {
    const file = config.typecheckTagMap;
    const { absolute, current } = await locate(project, tracked, file);
    const next = renderTagMap(await tagMapEntries(project, config));
    const detail =
      current === undefined ? 'the file does not exist' : 'custom element definitions changed';
    files.push({ file, absolute, current, next, detail });
  }
  return files;
}

/**
 * The generated typing files that are out of date.
 *
 * @param project - The project
 * @param config - Its configuration
 * @param tracked - The project's tracked engine files
 * @throws `furnace-jsconfig-invalid` when a named jsconfig is missing or not plain JSON
 */
export async function typingDrift(
  project: FurnaceProject,
  config: FurnaceConfig,
  tracked: TrackedFiles
): Promise<TypingDrift[]> {
  return (await typingFiles(project, config, tracked))
    .filter((file) => file.next !== file.current)
    .map(({ file, detail }) => ({ file, detail }));
}

/**
 * Brings the generated typing files up to date as part of a transaction.
 *
 * @param project - The project
 * @param config - The configuration as it will be once the transaction commits
 * @param tracked - The project's tracked engine files
 * @param tx - The transaction the writes join
 * @returns The files written
 */
export async function writeTypingFiles(
  project: FurnaceProject,
  config: FurnaceConfig,
  tracked: TrackedFiles,
  tx: Transaction
): Promise<string[]> {
  const written: string[] = [];
  for (const file of await typingFiles(project, config, tracked)) {
    if (file.next === file.current) continue;
    const named = configuredPath(file.file);
    if (named.tree === 'engine') {
      await tracked.write(tx, named.path, file.next);
    } else {
      await tx.write(file.absolute, file.next);
    }
    written.push(file.file);
  }
  return written;
}
