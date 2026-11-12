// SPDX-License-Identifier: EUPL-1.2
/**
 * The TypeScript compiler API as both type passes use it: loading it, the
 * Firefox-globals shim, and which diagnostics count. Owned-file checkJs and
 * the whole-project typecheck share all of it, so a file cannot pass one and
 * fail the other for a reason the operator could not see.
 */
import { dirname, resolve } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { readTextIfExists } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { FIREFOX_GLOBALS_SHIM, LIT_TYPES_SHIM, LOOSE_LIT_SHIM, TEST_HARNESS_SHIM } from './shim.js';

/** The compiler API module. */
export type TypeScript = typeof import('typescript');

/**
 * Packages tried for the compiler API, in order. TypeScript 7's `typescript`
 * ships no compiler API; a project on it installs `@typescript/typescript6`
 * beside it, or aliases `typescript` to that package.
 */
const API_PACKAGES = ['typescript', '@typescript/typescript6'];

const load = (name: string): Promise<unknown> => import(name);

function isApi(candidate: unknown): candidate is TypeScript {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'createProgram' in candidate &&
    typeof candidate.createProgram === 'function'
  );
}

/**
 * Loads the compiler API: `typescript` when it carries it, else
 * `@typescript/typescript6`, resolved from where FireForge is installed (the
 * project's own dependencies).
 *
 * @throws FireForgeError `typescript-missing` when neither package carries it
 */
export async function loadTypeScript(): Promise<TypeScript> {
  for (const name of API_PACKAGES) {
    let loaded: unknown;
    try {
      loaded = await load(name);
    } catch {
      continue;
    }
    const candidate = isApi(loaded)
      ? loaded
      : typeof loaded === 'object' && loaded !== null && 'default' in loaded
        ? loaded.default
        : undefined;
    if (isApi(candidate)) return candidate;
  }
  throw new FireForgeError(
    'typescript-missing',
    'No installed package carries the TypeScript compiler API.',
    {
      exitCode: ExitCode.MISSING_DEPENDENCY,
      hint: 'Install "typescript" 6 or older in the project, or with TypeScript 7 also "@typescript/typescript6".',
    }
  );
}

const REFERENCE = /^\s*\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']\s*\/?>\s*$/;

/**
 * Inlines `/// <reference path>` directives, recursively and once each: the
 * shim is served at a synthetic path, against which a relative reference
 * would resolve to nothing.
 */
async function inlineReferences(
  source: string,
  directory: string,
  seen: Set<string>
): Promise<string> {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const target = REFERENCE.exec(line)?.[1];
    if (target === undefined) {
      out.push(line);
      continue;
    }
    const absolute = resolve(directory, target);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = await readTextIfExists(absolute);
    out.push(
      text === undefined
        ? `// (fireforge: unresolved /// <reference path="${target}">)`
        : await inlineReferences(text, dirname(absolute), seen)
    );
  }
  return out.join('\n');
}

/** What a shim is composed of. */
export interface ShimOptions {
  /** Type Lit's modules with closed member lists. */
  readonly litTypes: boolean;
  /** Append the loose test-harness globals after the project shim. */
  readonly testHarness?: boolean;
}

/** A composed shim and the synthetic file name it is served under. */
export interface Shim {
  readonly fileName: string;
  readonly source: string;
}

/**
 * Composes the shim: the built-in Firefox globals, typed or loose Lit, the
 * project's `.d.ts` (which can merge members into the shim's interfaces),
 * then for tests the loose harness globals, which a typed declaration in the
 * project shim precedes and so wins over.
 *
 * @param projectRoot - Absolute project root
 * @param projectShim - Project-relative `.d.ts`, if configured
 * @param options - See {@link ShimOptions}
 * @throws FireForgeError `typescript-shim-missing` when the project shim does not exist
 */
export async function composeShim(
  projectRoot: string,
  projectShim: string | undefined,
  options: ShimOptions
): Promise<Shim> {
  const parts = [FIREFOX_GLOBALS_SHIM, options.litTypes ? LIT_TYPES_SHIM : LOOSE_LIT_SHIM];
  if (projectShim !== undefined) {
    const absolute = resolve(projectRoot, projectShim);
    const text = await readTextIfExists(absolute);
    if (text === undefined) {
      throw new FireForgeError(
        'typescript-shim-missing',
        `The TypeScript shim ${projectShim} does not exist.`,
        {
          exitCode: ExitCode.CONFIG_ERROR,
          hint: 'Create the file or correct its path in fireforge.json.',
        }
      );
    }
    parts.push(
      `// project shim: ${projectShim}`,
      await inlineReferences(text, dirname(absolute), new Set([absolute]))
    );
  }
  if (options.testHarness === true) parts.push(TEST_HARNESS_SHIM);
  const source = parts.join('\n');
  return { fileName: `__fireforge_globals_${hash(source).slice(0, 12)}.d.ts`, source };
}

/**
 * Codes that are noise when Firefox JavaScript is checked outside its build:
 * `resource://` and `chrome://` URLs do not resolve, and the shim is narrow.
 * TS2305 and TS2306 still count on a specifier that resolved to a real file.
 */
const SUPPRESSED_CODES: ReadonlySet<number> = new Set([2307, 2306, 2305, 2792, 2580, 7016]);

/** Undefined free identifiers, reported at the configured severity. */
const UNDEFINED_IDENTIFIER_CODES: ReadonlySet<number> = new Set([2304, 2552]);

/** Codes that count when their import's specifier resolved to a real file. */
const RESOLVED_MEMBER_CODES: ReadonlySet<number> = new Set([2305, 2306]);

const UNDEFINED_IDENTIFIER_HINT =
  '(undefined identifier: import or declare it, add the global to the project shim, or tune ' +
  '"undefinedIdentifiers")';

/** How undefined identifiers are reported. */
export type UndefinedIdentifiers = 'off' | 'warning' | 'error';

/** A diagnostic that counts, as both passes report it. */
export interface JudgedDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code: number;
}

function importSpecifierAt(
  ts: TypeScript,
  file: import('typescript').SourceFile,
  position: number
): string | undefined {
  const statement = file.statements.find(
    (candidate) => position >= candidate.getStart(file) && position < candidate.end
  );
  if (statement === undefined) return undefined;
  if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return undefined;
  const specifier = statement.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

/**
 * Judges one diagnostic: dropped when it is resolution or shim noise (a
 * missing export of a module that did resolve still counts) or an undefined
 * identifier under `off`; otherwise its severity and flattened message.
 *
 * @param ts - The compiler API
 * @param diagnostic - The diagnostic
 * @param policy - Undefined-identifier severity, and whether a specifier
 *   imported from a file resolved to a real file
 */
export function judgeDiagnostic(
  ts: TypeScript,
  diagnostic: import('typescript').Diagnostic,
  policy: {
    readonly undefinedIdentifiers: UndefinedIdentifiers;
    isResolved(containingFile: string, specifier: string): boolean;
  }
): JudgedDiagnostic | undefined {
  const { code, file, start } = diagnostic;
  if (SUPPRESSED_CODES.has(code)) {
    const specifier =
      RESOLVED_MEMBER_CODES.has(code) && file !== undefined && start !== undefined
        ? importSpecifierAt(ts, file, start)
        : undefined;
    if (
      specifier === undefined ||
      file === undefined ||
      !policy.isResolved(file.fileName, specifier)
    ) {
      return undefined;
    }
  }
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (UNDEFINED_IDENTIFIER_CODES.has(code)) {
    if (policy.undefinedIdentifiers === 'off') return undefined;
    return {
      severity: policy.undefinedIdentifiers,
      message: `${message} ${UNDEFINED_IDENTIFIER_HINT}`,
      code,
    };
  }
  const severity = diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';
  return { severity, message, code };
}

/**
 * Wraps a compiler host so `lib.dom.d.ts` declares Gecko's cross-compartment
 * `isInstance` predicate on every DOM constructor, and
 * `MouseEvent.MOZ_SOURCE_PEN`.
 *
 * @param ts - The compiler API
 * @param host - The host to wrap
 */
export function withGeckoDomTypes(
  ts: TypeScript,
  host: import('typescript').CompilerHost
): import('typescript').CompilerHost {
  const original = host.getSourceFile.bind(host);
  return {
    ...host,
    getSourceFile(fileName, languageVersion, ...rest) {
      const file = original(fileName, languageVersion, ...rest);
      if (file === undefined || !fileName.endsWith('/lib.dom.d.ts')) return file;
      const source = file.text.replace(
        /declare var (\w+): \{\s*prototype: (\w+);/g,
        (declaration: string, name: string, instance: string) =>
          `${declaration}\n    isInstance(value: unknown): value is ${instance};` +
          (name === 'MouseEvent' ? '\n    readonly MOZ_SOURCE_PEN: number;' : '')
      );
      return ts.createSourceFile(fileName, source, languageVersion, true);
    },
  };
}
