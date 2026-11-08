// SPDX-License-Identifier: EUPL-1.2
/**
 * Assertion detection for the `test-needs-assertion` floor.
 *
 * A browser-chrome test counts as asserting when it contains a real call to
 * one of the harness assertion functions: bare `ok`/`is`/`isnot`/`isDeeply`
 * (also `window.`-qualified or optional-chained, as the globals are window
 * properties), or a member of `Assert` or `SimpleTest` from the enumerated
 * assertion surface. `SimpleTest` is mostly harness API, so
 * `SimpleTest.finish()` and `SimpleTest.waitForExplicitFinish()` are not
 * assertions, and `SpecialPowers.ok(` is API surface, not an assertion.
 *
 * Detection walks the AST so a string or comment that merely spells a call
 * (`info("the tab is (not) loaded")`) does not count, and a file that
 * declares its own `is`/`ok` helper does not satisfy the floor through bare
 * calls of it. Source acorn cannot parse falls back to a textual match at a
 * call boundary.
 */
import type * as estree from 'estree';

import { type AcornESTreeNode, parseModule, parseScript, walkAST } from './ast-utils.js';

type Program = AcornESTreeNode<estree.Program>;

const BARE_ASSERTIONS: ReadonlySet<string> = new Set(['ok', 'is', 'isnot', 'isDeeply']);

const NAMESPACED_ASSERTIONS: ReadonlySet<string> = new Set([
  'ok',
  'is',
  'isnot',
  'isDeeply',
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
  // todo* record an expected failure, which is still a recorded assertion outcome.
  'todo',
  'todo_is',
  'todo_isnot',
]);

const TEXTUAL_ASSERTION = new RegExp(
  `(?<![\\w.#$-])(?:(?:Assert|SimpleTest)\\.(?:${[...NAMESPACED_ASSERTIONS].join('|')})\\s*\\(|(?:window\\.|[\\w$]+\\?\\.)?(?:${[...BARE_ASSERTIONS].join('|')})\\s*\\()`
);

function parseTest(content: string): Program | null {
  for (const parse of [parseScript, parseModule]) {
    try {
      return parse(content);
    } catch {
      // Try the next goal symbol.
    }
  }
  return null;
}

/** Names the program declares itself as functions or variables, at any depth. */
function locallyDeclaredNames(program: Program): Set<string> {
  const names = new Set<string>();
  walkAST(program, {
    enter(node) {
      const declared = node;
      // `export default function () {}` has a null id at runtime.
      const functionId = declared.type === 'FunctionDeclaration' ? declared.id : undefined;
      if (functionId !== undefined) names.add((functionId as estree.Identifier | null)?.name ?? '');
      else if (declared.type === 'VariableDeclarator' && declared.id.type === 'Identifier')
        names.add(declared.id.name);
    },
  });
  return names;
}

function isAssertionCall(call: estree.CallExpression, local: ReadonlySet<string>): boolean {
  const callee = call.callee;
  if (callee.type === 'Identifier')
    return BARE_ASSERTIONS.has(callee.name) && !local.has(callee.name);
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.property.type !== 'Identifier'
  )
    return false;
  const member = callee.property.name;
  const object = callee.object;
  if (callee.optional && BARE_ASSERTIONS.has(member)) return true;
  if (object.type !== 'Identifier') return false;
  if (object.name === 'window') return BARE_ASSERTIONS.has(member);
  return (
    (object.name === 'Assert' || object.name === 'SimpleTest') && NAMESPACED_ASSERTIONS.has(member)
  );
}

/** True when `content` contains at least one assertion call. */
export function hasBrowserChromeAssertion(content: string): boolean {
  const program = parseTest(content);
  if (!program) return TEXTUAL_ASSERTION.test(content);
  const local = locallyDeclaredNames(program);
  let found = false;
  walkAST(program, {
    enter(node) {
      const candidate = node;
      if (candidate.type === 'CallExpression' && isAssertionCall(candidate, local)) {
        found = true;
        this.skip();
      }
    },
  });
  return found;
}
