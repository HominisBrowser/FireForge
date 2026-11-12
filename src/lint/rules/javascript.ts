// SPDX-License-Identifier: EUPL-1.2
/**
 * Content rules for owned JavaScript: import conventions, the marker on
 * upstream edits, JSDoc, the assertion floor of browser tests, and observer
 * topic naming.
 */
import type * as estree from 'estree';

import { markerComment } from '../../config/index.js';
import {
  blankJsComments,
  isStringLiteral,
  lineAt,
  parseEither,
  relativeImportLines,
  walkJs,
} from '../../syntax/index.js';
import type { OwnedFile } from '../input.js';
import { basename, type Draft, isJsFile, type Rule, type RuleContext } from '../rule.js';
import { moduleJsDocProblems, scriptJsDocProblems } from './jsdoc.js';

function jsFiles(context: RuleContext, accept: (file: OwnedFile) => boolean): OwnedFile[] {
  return context.owned
    .all()
    .filter(
      (file) =>
        file.text !== undefined &&
        isJsFile(file.path) &&
        context.selected(file.path) &&
        accept(file)
    );
}

function text(file: OwnedFile): string {
  return file.text ?? '';
}

const BARE_ASSERTIONS: ReadonlySet<string> = new Set(['ok', 'is', 'isnot', 'isDeeply']);
const NAMESPACED_ASSERTIONS: ReadonlySet<string> = new Set([
  ...BARE_ASSERTIONS,
  'equal',
  'notEqual',
  'deepEqual',
  'notDeepEqual',
  'strictEqual',
  'notStrictEqual',
  'greater',
  'greaterOrEqual',
  'less',
  'lessOrEqual',
  'stringMatches',
  'stringContains',
  'throws',
  'rejects',
  'todo',
  'todo_is',
  'todo_isnot',
]);
const TEXTUAL_ASSERTION = new RegExp(
  `(?<![\\w.#$-])(?:(?:Assert|SimpleTest)\\.(?:${[...NAMESPACED_ASSERTIONS].join('|')})\\s*\\(|(?:window\\.|[\\w$]+\\?\\.)?(?:${[...BARE_ASSERTIONS].join('|')})\\s*\\()`
);

function isAssertionCall(call: estree.CallExpression, local: ReadonlySet<string>): boolean {
  const callee = call.callee;
  if (callee.type === 'Identifier')
    return BARE_ASSERTIONS.has(callee.name) && !local.has(callee.name);
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property.type !== 'Identifier') return false;
  const member = callee.property.name;
  if (callee.optional && BARE_ASSERTIONS.has(member)) return true;
  if (callee.object.type !== 'Identifier') return false;
  if (callee.object.name === 'window') return BARE_ASSERTIONS.has(member);
  return (
    (callee.object.name === 'Assert' || callee.object.name === 'SimpleTest') &&
    NAMESPACED_ASSERTIONS.has(member)
  );
}

/**
 * Whether a browser test makes at least one assertion: a bare `ok`, `is`,
 * `isnot` or `isDeeply` call (also `window.`-qualified or optional-chained)
 * that the file does not declare itself, or an `Assert.*` / `SimpleTest.*`
 * assertion. Strings and comments that spell a call do not count. Source
 * acorn cannot parse is matched as text at a call boundary.
 *
 * @param source - The test source
 */
export function hasAssertion(source: string): boolean {
  const parsed = parseEither(source);
  if (parsed === undefined) return TEXTUAL_ASSERTION.test(blankJsComments(source));
  const local = new Set<string>();
  walkJs(parsed.program, (node) => {
    if (node.type === 'FunctionDeclaration') local.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier')
      local.add(node.id.name);
  });
  let found = false;
  walkJs(parsed.program, (node) => {
    if (found || (node.type === 'CallExpression' && isAssertionCall(node, local))) found = true;
    return !found;
  });
  return found;
}

function isBrowserTest(path: string): boolean {
  const name = basename(path);
  return (
    path.endsWith('.js') &&
    /\/tests?\//.test(path) &&
    name.startsWith('browser_') &&
    name !== 'head.js' &&
    !/^head_.*\.js$/.test(name)
  );
}

/** Firefox's own topics, which owned code may observe or simulate under any name. */
const FIREFOX_TOPICS: ReadonlySet<string> = new Set([
  'idle-daily',
  'profile-after-change',
  'profile-before-change',
  'xpcom-shutdown',
  'xpcom-will-shutdown',
  'final-ui-startup',
  'browser-delayed-startup-finished',
  'sessionstore-windows-restored',
  'document-element-inserted',
  'content-document-global-created',
  'http-on-modify-request',
  'http-on-examine-response',
  'nsPref:changed',
  'browser-window-before-show',
  'domwindowopened',
  'domwindowclosed',
]);

const OBSERVER_METHODS: ReadonlySet<string> = new Set([
  'addObserver',
  'removeObserver',
  'notifyObservers',
]);
const OBSERVER_CALL_TEXT =
  /\b(?:addObserver|removeObserver|notifyObservers)\s*\([^,()]*,\s*(["'`])([^"'`$\\]*)\1/g;

/** The topic argument of an observer-service call, when it is a plain string. */
function observerTopic(node: estree.Node): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee;
  const method =
    callee.type === 'Identifier'
      ? callee.name
      : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
        ? callee.property.name
        : undefined;
  if (method === undefined || !OBSERVER_METHODS.has(method)) return undefined;
  const topic = node.arguments[1];
  if (isStringLiteral(topic)) return topic.value;
  if (topic?.type === 'TemplateLiteral' && topic.expressions.length === 0) {
    return topic.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * Observer topics a source names that carry the binary name but not the
 * `<name>-<noun>-<verb>` shape: the second argument of `addObserver`,
 * `removeObserver` and `notifyObservers`, when a plain string. Source acorn
 * cannot parse is matched as comment-blanked text.
 *
 * @param source - JavaScript source
 * @param binaryName - The project's binary name, lower case
 */
export function misnamedObserverTopics(
  source: string,
  binaryName: string
): { topic: string; line: number }[] {
  const calls: { topic: string; offset: number }[] = [];
  const parsed = parseEither(source);
  if (parsed === undefined) {
    for (const match of blankJsComments(source).matchAll(OBSERVER_CALL_TEXT)) {
      calls.push({ topic: match[2] ?? '', offset: match.index });
    }
  } else {
    walkJs(parsed.program, (node) => {
      const topic = observerTopic(node);
      if (topic !== undefined) calls.push({ topic, offset: node.start });
    });
  }
  return calls
    .filter(
      ({ topic }) =>
        !FIREFOX_TOPICS.has(topic) &&
        !topic.startsWith('quit-application') &&
        topic.toLowerCase().includes(binaryName) &&
        !/^\w+-[a-z]+-[a-z]+/.test(topic)
    )
    .map(({ topic, offset }) => ({ topic, line: lineAt(source, offset) }));
}

const relativeImport: Rule = {
  id: 'relative-import',
  severity: 'error',
  description: 'Owned JavaScript imports through resource:// or chrome:// URLs, not relative paths',
  async check(context) {
    const drafts: Draft[] = [];
    const binary = context.config.binaryName;
    for (const file of jsFiles(context, (candidate) => !context.component(candidate.path))) {
      let lines = relativeImportLines(text(file));
      if (!file.created) {
        const added = new Set((await context.owned.added(file.change)).map((entry) => entry.line));
        lines = lines.filter((line) => added.has(line));
      }
      const [line] = lines;
      if (line === undefined) continue;
      drafts.push({
        path: file.path,
        line,
        group: file.group,
        message: `Relative imports are not allowed. Use "resource:///modules/${binary}/" for modules or "chrome://browser/content/" for subscripts.`,
      });
    }
    return drafts;
  },
};

const modificationComment: Rule = {
  id: 'missing-modification-comment',
  severity: 'warning',
  description: 'An edit to upstream JavaScript carries the `// MARKER:` comment',
  async check(context) {
    const marker = `// ${markerComment(context.config).toUpperCase()}:`;
    const drafts: Draft[] = [];
    for (const file of jsFiles(context, (candidate) => !candidate.created)) {
      const added = await context.owned.added(file.change);
      if (added.length === 0) continue;
      if (added.some((entry) => entry.text.toUpperCase().includes(marker))) continue;
      drafts.push({
        path: file.path,
        group: file.group,
        message: `This upstream file's changes carry no "${marker}" comment marking them.`,
      });
    }
    return drafts;
  },
};

function jsdocRule(id: 'jsdoc' | 'jsdoc-class-method', classMethods: boolean): Rule {
  return {
    id,
    severity: classMethods ? 'off' : 'error',
    description: classMethods
      ? 'Methods of exported classes of owned modules carry JSDoc'
      : 'Exports of owned modules carry JSDoc naming their parameters and return',
    check(context) {
      return jsFiles(context, (file) => file.created && file.path.endsWith('.sys.mjs')).flatMap(
        (file) =>
          moduleJsDocProblems(text(file))
            .filter((problem) => problem.classMethod === classMethods)
            .map((problem) => ({
              path: file.path,
              line: problem.line,
              group: file.group,
              message: problem.message,
            }))
      );
    },
  };
}

const chromeScriptJsDoc: Rule = {
  id: 'chrome-script-jsdoc',
  severity: 'off',
  description: 'Top-level functions and classes of owned chrome scripts carry JSDoc',
  check(context) {
    return jsFiles(
      context,
      (file) => file.created && file.path.endsWith('.js') && !file.path.endsWith('.sys.mjs')
    ).flatMap((file): Draft[] => {
      const problems = scriptJsDocProblems(text(file));
      if (problems === undefined) {
        return [
          {
            path: file.path,
            group: file.group,
            severity: 'notice',
            message: 'The file did not parse as a script, so its JSDoc was not checked.',
          },
        ];
      }
      return problems.map((problem) => ({
        path: file.path,
        line: problem.line,
        group: file.group,
        message: problem.message,
      }));
    });
  },
};

const testAssertion: Rule = {
  id: 'test-needs-assertion',
  severity: 'off',
  description: 'Every owned or modified browser test makes at least one assertion',
  check(context) {
    return jsFiles(context, (file) => isBrowserTest(file.path))
      .filter((file) => !hasAssertion(text(file)))
      .map((file) => ({
        path: file.path,
        group: file.group,
        message:
          'The test makes no assertion (Assert.*, ok(), is(), isnot(), isDeeply()). Add one that ' +
          'pins user-visible behaviour, or remove the test.',
      }));
  },
};

const observerTopics: Rule = {
  id: 'observer-topic-naming',
  severity: 'warning',
  description: 'Observer topics carrying the binary name follow `<name>-<noun>-<verb>`',
  check(context) {
    const name = context.config.binaryName.toLowerCase();
    return jsFiles(context, () => true).flatMap((file) =>
      misnamedObserverTopics(text(file), name).map(({ topic, line }) => ({
        path: file.path,
        line,
        group: file.group,
        message: `Observer topic "${topic}" should follow the "${name}-<noun>-<verb>" naming convention.`,
      }))
    );
  },
};

/** The JavaScript content rules. */
export const javascriptRules: readonly Rule[] = [
  relativeImport,
  modificationComment,
  jsdocRule('jsdoc', false),
  jsdocRule('jsdoc-class-method', true),
  chromeScriptJsDoc,
  testAssertion,
  observerTopics,
];
