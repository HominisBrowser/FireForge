// SPDX-License-Identifier: EUPL-1.2
/**
 * Wiring a chrome subscript into the browser: the `loadSubScript` call, the
 * optional init and destroy calls, the optional `#include` of a DOM fragment
 * into the top-level chrome document, and the jar.mn entry that packages it.
 */
import { posix } from 'node:path';

import { usageError } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import { escapeRegExp } from '../kernel/text.js';
import type { TrackedFiles } from '../project/index.js';
import { lineStart } from '../syntax/index.js';
import { EditSession, type Plan, type PlanStep } from './files.js';
import {
  addDestroy,
  addInit,
  addSubscript,
  validateWireExpression,
  validateWireName,
} from './js.js';
import { browserJarTarget, planJar } from './register.js';

/** Where the browser's chrome scripts live. */
const BROWSER_MAIN = 'browser/base/content/browser-main.js';
const BROWSER_INIT = 'browser/base/content/browser-init.js';
const BROWSER_BASE = 'browser/base';

/** What to wire. */
export interface WireRequest {
  /** Subscript name, without `.js`. */
  name: string;
  /** Engine-relative directory holding `<name>.js`. */
  subscriptDir: string;
  /** Comment marker for the lint rules, such as `MYBROWSER:`. */
  marker: string;
  /** Expression called from `onLoad`. */
  init?: string | undefined;
  /** Expression called from `onUnload`. */
  destroy?: string | undefined;
  /** Subscript whose init block the new init block follows. */
  after?: string | undefined;
  /** A DOM fragment to `#include`, and the chrome document that includes it. */
  dom?: { file: string; target: string } | undefined;
  /** Refuse when `<subscriptDir>/<name>.js` does not exist. */
  requireSubscript?: boolean | undefined;
}

function missing(path: string, hint: string): FireForgeError {
  return new FireForgeError('wire-file-missing', `${path} not found.`, { hint });
}

const ID = (id: string): string => `(?<![\\w-])id\\s*=\\s*["']${escapeRegExp(id)}["']`;

/**
 * The lines of `target` that inline the fragment's root element, from its
 * start tag to the matching end tag, replaced by the directive. Undefined
 * when the document has no element of that tag and id, or it does not
 * occupy whole lines.
 */
function replaceInlined(target: string, fragment: string, directive: string): string | undefined {
  const root = /<([A-Za-z][\w:.-]*)\b[^>]*?(?<![\w-])id\s*=\s*["']([^"']+)["']/.exec(fragment);
  const [tag, id] = [root?.[1], root?.[2]];
  if (tag === undefined || id === undefined) return undefined;
  const name = escapeRegExp(tag);
  const open = new RegExp(`<${name}\\b[^>]*?${ID(id)}`).exec(target);
  if (open === null) return undefined;
  const tags = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'g');
  tags.lastIndex = open.index;
  let depth = 0;
  let end: number | undefined;
  for (let match = tags.exec(target); match !== null; match = tags.exec(target)) {
    if (match[1] === '/') depth--;
    else if (match[2] !== '/') depth++;
    if (depth === 0) {
      end = match.index + match[0].length;
      break;
    }
  }
  if (end === undefined) return undefined;
  const start = lineStart(target, open.index);
  const lineEnd = target.indexOf('\n', end);
  const stop = lineEnd === -1 ? target.length : lineEnd;
  if (target.slice(start, open.index).trim() !== '' || target.slice(end, stop).trim() !== '') {
    return undefined;
  }
  return target.slice(0, start) + directive + target.slice(stop);
}

/**
 * Adds `#include <fragment>` to a chrome document: before the
 * `browser-sets.inc` include, else after `<html:body>`. A fragment already
 * inlined in the document is replaced by the include.
 *
 * @returns The new text, or undefined when the include is already there
 */
async function addDomInclude(
  session: EditSession,
  dom: { file: string; target: string }
): Promise<string | undefined> {
  const text = await session.read(dom.target);
  if (text === undefined) {
    throw missing(dom.target, 'Pass --target <path>, or set the chrome document in the project.');
  }
  const directive = `#include ${posix.relative(posix.dirname(dom.target), dom.file)}`;
  if (new RegExp(`^${escapeRegExp(directive)}$`, 'm').test(text)) return undefined;
  const fragment = await session.read(dom.file);
  const inlined = fragment === undefined ? undefined : replaceInlined(text, fragment, directive);
  if (inlined !== undefined) return inlined;
  const lines = text.split('\n');
  const sets = lines.findIndex((line) => /^\s*#include\s+.*browser-sets\.inc/.test(line));
  const body = lines.findIndex((line) => /<html:body/.test(line));
  const at = sets !== -1 ? sets : body !== -1 ? body + 1 : -1;
  if (at === -1) {
    throw new FireForgeError(
      'wire-no-anchor',
      `${dom.target} has neither "#include browser-sets.inc" nor <html:body> to insert before.`,
      { hint: 'Add one of them, or target a chrome document that has one with --target.' }
    );
  }
  lines.splice(at, 0, directive);
  return lines.join('\n');
}

/**
 * Plans a subscript's wiring. Every step is computed before anything is
 * written, so a step that cannot be done leaves the browser untouched.
 *
 * @param files - Where the browser's files live
 * @param request - What to wire
 * @throws `invalid-argument` for a name or expression that is not safe to generate code from
 */
export async function planWire(files: TrackedFiles, request: WireRequest): Promise<Plan> {
  const { name, marker } = request;
  validateWireName(name);
  if (request.after !== undefined) validateWireName(request.after, 'after name');
  if (request.init !== undefined) validateWireExpression(request.init, 'init expression');
  if (request.destroy !== undefined) validateWireExpression(request.destroy, 'destroy expression');
  const subscript = `${request.subscriptDir}/${name}.js`;
  if (request.requireSubscript === true && !(await files.exists(subscript))) {
    throw usageError(`Subscript file not found: ${subscript}`, 'Create the file before wiring it.');
  }

  if (request.dom !== undefined && !(await files.exists(request.dom.file))) {
    throw usageError(`DOM fragment not found: ${request.dom.file}`);
  }

  const session = new EditSession(files);
  const steps: PlanStep[] = [];
  const edit = async (
    path: string,
    change: string,
    make: (text: string) => string | undefined
  ): Promise<void> => {
    const text = await session.read(path);
    if (text === undefined) throw missing(path, 'Check that the project has this file.');
    const next = make(text);
    if (next !== undefined) session.set(path, next);
    steps.push({ path, change, present: next === undefined });
  };

  await edit(BROWSER_MAIN, `loadSubScript ${name}.js`, (text) => addSubscript(text, name, marker));
  if (request.init !== undefined) {
    const { init, after } = request;
    await edit(BROWSER_INIT, `onLoad: ${init}`, (text) => addInit(text, init, { after, marker }));
  }
  if (request.destroy !== undefined) {
    const { destroy } = request;
    await edit(BROWSER_INIT, `onUnload: ${destroy}`, (text) => addDestroy(text, destroy, marker));
  }
  if (request.dom !== undefined) {
    const { dom } = request;
    const next = await addDomInclude(session, dom);
    if (next !== undefined) session.set(dom.target, next);
    steps.push({ path: dom.target, change: `#include ${dom.file}`, present: next === undefined });
  }
  const source = posix.join(posix.relative(BROWSER_BASE, request.subscriptDir), `${name}.js`);
  const jar = await planJar(
    session,
    browserJarTarget(`content/browser/${name}.js`, source),
    undefined
  );
  steps.push(...jar.steps);
  return { edits: session.edits(), steps };
}
