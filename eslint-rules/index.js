// SPDX-License-Identifier: EUPL-1.2
/**
 * Local ESLint rules enforcing FireForge house conventions that no published
 * plugin covers.
 *
 * Each rule here targets a hand-rolled pattern that gets repeated across
 * dozens of files, where one copy is eventually silently broken — a malformed
 * regex character class that escapes nothing, an errno check that
 * misclassifies a plain `{code}` object. These rules are what stop the
 * pattern coming back.
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
        'Hand-written copies drift: a class like ' +
        '`[.*+?^${}()|[\\\\]\\\\\\\\]` closes early and escapes nothing.',
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

/** Reports `Record<string, unknown>` in exported function signatures. */
const noUntypedJsonDocument = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use JsonObject/JsonValue (src/types/json.ts), ParsedRecord (src/utils/parse.ts), or a named ' +
        'domain type instead of Record<string, unknown> in exported function signatures.',
    },
    schema: [],
    messages: {
      untypedDocument:
        'Untyped dictionary in an exported signature. `Record<string, unknown>` gives callers no value ' +
        'contract, which is how piecemeal `typeof`-and-cast narrowing accretes downstream. ' +
        'Use `JsonObject`/`JsonValue` (src/types/json.ts) for raw JSON documents, ' +
        '`ParsedRecord` (src/utils/parse.ts) for boundary parsing, or a named domain type.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    // `isObject` in validation.ts IS the sanctioned unknown→object bridge;
    // its type predicate necessarily names Record<string, unknown>.
    if (filename.endsWith('src/utils/validation.ts')) return {};
    const functionTypes = new Set([
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'TSDeclareFunction',
    ]);
    // Only functions attached straight to an export declaration count:
    // `export function f`, `export default function`, `export const f = () => …`.
    // Class methods stay exempt — ParsedRecord's constructor legitimately
    // takes the Record its factory just narrowed.
    const isDirectlyExported = (fn) => {
      const parent = fn.parent;
      if (!parent) return false;
      if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') {
        return true;
      }
      return (
        parent.type === 'VariableDeclarator' &&
        parent.parent?.type === 'VariableDeclaration' &&
        parent.parent.parent?.type === 'ExportNamedDeclaration'
      );
    };
    return {
      TSTypeReference(node) {
        if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') return;
        const args = (node.typeArguments ?? node.typeParameters)?.params ?? [];
        if (
          args.length !== 2 ||
          args[0].type !== 'TSStringKeyword' ||
          args[1].type !== 'TSUnknownKeyword'
        ) {
          return;
        }
        // Ascend to the function whose signature holds this annotation. The
        // walk stops at the INNERMOST function-like node, so annotations in
        // nested helpers inside an exported function's body never report.
        let child = node;
        let parent = node.parent;
        while (parent) {
          // A generic bound (`<T extends Record<string, unknown>>`) constrains
          // a caller-supplied shape; it is not a dictionary handed to callers.
          if (parent.type === 'TSTypeParameter') return;
          if (functionTypes.has(parent.type)) {
            if (child !== parent.body && isDirectlyExported(parent)) {
              context.report({ node, messageId: 'untypedDocument' });
            }
            return;
          }
          child = parent;
          parent = parent.parent;
        }
      },
    };
  },
};

/**
 * Reports `process.stdin.isTTY && process.stdout.isTTY` in favour of the
 * shared `stdioIsInteractive()` predicate.
 */
const noOpenCodedTtyCheck = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use stdioIsInteractive() from src/core/destructive.ts instead of open-coding the TTY pair check.',
    },
    schema: [],
    messages: {
      openCoded:
        'Use `stdioIsInteractive()` (src/core/destructive.ts) instead of open-coding ' +
        '`process.stdin.isTTY && process.stdout.isTTY`. Node types `isTTY` as `boolean` but at runtime ' +
        'it is `true | undefined`, and the eighteen open-coded copies this replaced carried nine ' +
        'different non-TTY refusal strings between them.',
    },
  },
  create(context) {
    /**
     * True for `process.<handle>.isTTY`, where `handle` is the one named.
     *
     * Deliberately handle-specific: this rule targets the
     * PROMPT-ANSWERABILITY check (`stdin && stdout`), not any TTY
     * conjunction. `logger.ts`'s spinner gate is `stdout && stderr`, a
     * different question — whether output can be redrawn — and must not be
     * routed through a predicate about whether a prompt can be answered.
     */
    function isProcessIsTty(node, handle) {
      return (
        node.type === 'MemberExpression' &&
        node.property.type === 'Identifier' &&
        node.property.name === 'isTTY' &&
        node.object.type === 'MemberExpression' &&
        node.object.property.type === 'Identifier' &&
        node.object.property.name === handle &&
        node.object.object.type === 'Identifier' &&
        node.object.object.name === 'process'
      );
    }

    return {
      LogicalExpression(node) {
        if (node.operator !== '&&') return;
        if (isProcessIsTty(node.left, 'stdin') && isProcessIsTty(node.right, 'stdout')) {
          context.report({ node, messageId: 'openCoded' });
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
    'no-untyped-json-document': noUntypedJsonDocument,
    'no-open-coded-tty-check': noOpenCodedTtyCheck,
  },
};
