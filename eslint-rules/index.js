// SPDX-License-Identifier: EUPL-1.2
/**
 * Local ESLint rules enforcing FireForge house conventions that no published
 * plugin covers.
 *
 * Each rule here exists because the 2026-08-06 quality survey found the same
 * hand-rolled pattern repeated across dozens of files — in several cases with
 * one copy silently broken (a malformed regex character class that escaped
 * nothing, four errno checks that misclassified plain `{code}` objects). The
 * sites are fixed; these rules are what stop them coming back.
 *
 * Deliberately plain JS with no build step and no dependencies: this directory
 * is tooling, is excluded from `tsconfig.json`, and never ships in `dist/`.
 */

/** Reports `X instanceof Error ? X.message : String(X)` in favour of `toError`. */
const noOpenCodedToError = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use toError(error).message from src/utils/errors.ts instead of open-coding error normalisation.',
    },
    schema: [],
    messages: {
      openCoded:
        'Use `toError({{name}}).message` (src/utils/errors.ts) instead of open-coding error normalisation. ' +
        'The open-coded form drops the `cause` chain and diverges from the ~30 sites that use the helper.',
      errorCast:
        'Use `toError({{name}}).message` instead of `({{name}} as Error).message`. The cast is unchecked: ' +
        'a non-Error throwable renders as the literal string "undefined" in operator output.',
    },
  },
  create(context) {
    return {
      // X instanceof Error ? X.message : String(X)
      ConditionalExpression(node) {
        const { test, consequent, alternate } = node;
        if (
          test.type !== 'BinaryExpression' ||
          test.operator !== 'instanceof' ||
          test.right.type !== 'Identifier' ||
          test.right.name !== 'Error' ||
          test.left.type !== 'Identifier'
        ) {
          return;
        }
        const name = test.left.name;
        const isMessageRead =
          consequent.type === 'MemberExpression' &&
          consequent.object.type === 'Identifier' &&
          consequent.object.name === name &&
          consequent.property.type === 'Identifier' &&
          consequent.property.name === 'message';
        // The alternate must be `String(<the same identifier>)`. Checking only
        // that the callee is named `String` reported
        // `e instanceof Error ? e.message : String(other)` — a different
        // fallback value, and not the idiom `toError` replaces — and even
        // `String()` with no arguments at all.
        const isStringCall =
          alternate.type === 'CallExpression' &&
          alternate.callee.type === 'Identifier' &&
          alternate.callee.name === 'String' &&
          alternate.arguments.length === 1 &&
          alternate.arguments[0].type === 'Identifier' &&
          alternate.arguments[0].name === name;
        if (isMessageRead && isStringCall) {
          context.report({ node, messageId: 'openCoded', data: { name } });
        }
      },
      // (X as Error).message
      'MemberExpression[property.name="message"]'(node) {
        const obj = node.object;
        if (
          obj.type === 'TSAsExpression' &&
          obj.typeAnnotation?.type === 'TSTypeReference' &&
          obj.typeAnnotation.typeName?.type === 'Identifier' &&
          obj.typeAnnotation.typeName.name === 'Error' &&
          obj.expression.type === 'Identifier'
        ) {
          context.report({
            node,
            messageId: 'errorCast',
            data: { name: obj.expression.name },
          });
        }
      },
    };
  },
};

/** Reports `(x as NodeJS.ErrnoException).code` in favour of `getNodeErrorCode`. */
const noErrnoCast = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use getNodeErrorCode from src/utils/errors.ts instead of casting to NodeJS.ErrnoException.',
    },
    schema: [],
    messages: {
      errnoCast:
        'Use `getNodeErrorCode(error)` (src/utils/errors.ts) instead of casting to NodeJS.ErrnoException. ' +
        'The cast performs no runtime check, so a throwable without `.code` silently yields undefined ' +
        'while the type claims otherwise.',
    },
  },
  create(context) {
    // Both spellings: the qualified `NodeJS.ErrnoException` and a bare
    // `ErrnoException` pulled in via import — the cast is equally unchecked.
    const isErrnoExceptionName = (typeName) =>
      (typeName?.type === 'TSQualifiedName' &&
        typeName.left?.type === 'Identifier' &&
        typeName.left.name === 'NodeJS' &&
        typeName.right?.type === 'Identifier' &&
        typeName.right.name === 'ErrnoException') ||
      (typeName?.type === 'Identifier' && typeName.name === 'ErrnoException');
    return {
      TSAsExpression(node) {
        const ann = node.typeAnnotation;
        // Every union member is checked, not just the first type reference:
        // `x as Foo | NodeJS.ErrnoException` is the same unchecked cast no
        // matter where the errno type sits in the union.
        const refs =
          ann?.type === 'TSTypeReference'
            ? [ann]
            : ann?.type === 'TSUnionType'
              ? ann.types.filter((t) => t.type === 'TSTypeReference')
              : [];
        if (refs.some((ref) => isErrnoExceptionName(ref.typeName))) {
          context.report({ node, messageId: 'errnoCast' });
        }
      },
    };
  },
};

/** Reports inline regex-metacharacter escaping in favour of the shared helper. */
const preferSharedRegexEscape = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Use escapeRegex from src/utils/regex.ts.' },
    schema: [],
    messages: {
      inlineEscape:
        'Use `escapeRegex(value)` from src/utils/regex.ts instead of an inline escape. ' +
        'Eight hand-written copies existed before 0.41.0 and one of them ' +
        '(`[.*+?^${}()|[\\\\]\\\\\\\\]`) closed its character class early and escaped nothing.',
      localHelper:
        'Import `escapeRegex` from src/utils/regex.ts instead of declaring a local escape helper.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (filename.replace(/\\/g, '/').endsWith('src/utils/regex.ts')) return {};
    return {
      // `<value>.replace(/[metachars]/g, '\\$&')` — the whole idiom, not just
      // a regex literal that happens to be a character class. Matching the
      // literal alone reported every unrelated class of six-plus punctuation
      // characters (delimiter and bracket matchers, tokenisers) and told the
      // author to call `escapeRegex`, which would not do what they wanted.
      CallExpression(node) {
        const { callee, arguments: args } = node;
        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'replace' ||
          args.length !== 2
        ) {
          return;
        }
        const [pattern, replacement] = args;
        if (!pattern.regex || !/^\[[.*+?^${}()|\\[\]]{6,}\]$/.test(pattern.regex.pattern)) return;
        // '\$&' — re-emit the matched metacharacter behind a backslash.
        if (replacement.type !== 'Literal' || replacement.value !== '\\$&') return;
        context.report({ node, messageId: 'inlineEscape' });
      },
      // `escapeRegex` / `escapeRegExp` only. The selector was
      // `^escape(Regex|RegExp|For[A-Z]\w*)$`, which matched every `escapeForX`
      // helper — `escapeForHtml`, `escapeForShell` — and told each of them to
      // import a REGEX escaper.
      'FunctionDeclaration[id.name=/^escape(Regex|RegExp|Regexp)$/]'(node) {
        context.report({ node: node.id, messageId: 'localHelper' });
      },
      // The same helper written as `const escapeRegex = (s) => …` or a
      // function expression — a declaration-only selector let those through.
      'VariableDeclarator[id.name=/^escape(Regex|RegExp|Regexp)$/]'(node) {
        if (
          node.init?.type === 'ArrowFunctionExpression' ||
          node.init?.type === 'FunctionExpression'
        ) {
          context.report({ node: node.id, messageId: 'localHelper' });
        }
      },
    };
  },
};

/** Reports JSDoc blocks whose body carries no text. */
const noEmptyJsdoc = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Reject JSDoc blocks with an empty body.' },
    schema: [],
    messages: {
      emptyJsdoc:
        'Empty JSDoc block. It satisfies `jsdoc/require-jsdoc` while documenting nothing, and with ' +
        '`declaration: true` it ships into the published .d.ts and editor hovers. Write the contract or remove it.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue;
          const body = comment.value
            .replace(/^\*/, '')
            .split('\n')
            .map((l) => l.replace(/^\s*\*?/, '').trim())
            .join('')
            .trim();
          if (body === '') {
            context.report({ loc: comment.loc, messageId: 'emptyJsdoc' });
          }
        }
      },
    };
  },
};

export default {
  rules: {
    'no-open-coded-to-error': noOpenCodedToError,
    'no-errno-cast': noErrnoCast,
    'prefer-shared-regex-escape': preferSharedRegexEscape,
    'no-empty-jsdoc': noEmptyJsdoc,
  },
};
