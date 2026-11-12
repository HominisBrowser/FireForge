// SPDX-License-Identifier: EUPL-1.2
/**
 * The languages the fork's files are written in, parsed once for every
 * module that reads them: JavaScript through acorn, CSS (comments,
 * declarations, `var()` references, raw colours), the shared-fragment
 * markers of component stylesheets.
 */
export {
  blankCssComments,
  type CssBlock,
  type CssComment,
  type CssDeclaration,
  cssVarReferences,
  customProperties,
  foreignVariables,
  parseCss,
  rawColors,
  type Stylesheet,
} from './css.js';
export { fragmentEnd, fragmentExpansions, fragmentInclude, fragmentIncludes } from './fragments.js';
export {
  blankJsComments,
  blankJsCommentsParsed,
  importSpecifiers,
  isStringLiteral,
  type JsComment,
  jsTokens,
  lineAt,
  lineIndent,
  lineStart,
  parseEither,
  parseJs,
  type Positioned,
  relativeImportLines,
  walkJs,
} from './js.js';
