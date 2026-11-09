// SPDX-License-Identifier: EUPL-1.2
/**
 * The TypeScript compiler API that `typecheck`, checkJs and `typecheck --explain`
 * program against. TypeScript 7's `typescript` package ships no compiler API; a
 * project on it installs `@typescript/typescript6` beside it, or aliases
 * `typescript` to that package, and either way the API is found here.
 */

/** The package names tried, in order. */
const API_PACKAGES = ['typescript', '@typescript/typescript6'] as const;

type TypeScriptApi = typeof import('typescript');

/** A loaded compiler API and the package it came from. */
export interface LoadedTypeScriptApi {
  ts: TypeScriptApi;
  packageName: (typeof API_PACKAGES)[number];
}

/** What this module imports; injectable so a test can stand in for a missing or API-less package. */
export type ModuleImporter = (name: string) => Promise<unknown>;

const importModule: ModuleImporter = (name) => import(name);

function hasCompilerApi(candidate: unknown): candidate is TypeScriptApi {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { createProgram?: unknown }).createProgram === 'function'
  );
}

/**
 * The first installed package that carries the compiler API: `typescript` when
 * it is TypeScript 6 or older, else `@typescript/typescript6`.
 *
 * @param load - Imports a package by name
 * @returns The API and its package, or undefined when neither carries one
 */
export async function loadTypeScriptApi(
  load: ModuleImporter = importModule
): Promise<LoadedTypeScriptApi | undefined> {
  for (const packageName of API_PACKAGES) {
    let loaded: unknown;
    try {
      loaded = await load(packageName);
    } catch {
      continue;
    }
    const candidate =
      hasCompilerApi(loaded) || typeof loaded !== 'object' || loaded === null
        ? loaded
        : (loaded as { default?: unknown }).default;
    if (hasCompilerApi(candidate)) return { ts: candidate, packageName };
  }
  return undefined;
}

/** What a command says when no installed package carries the compiler API. */
export const MISSING_TYPESCRIPT_API =
  'Install "typescript" 6 or older, or with TypeScript 7 also "@typescript/typescript6", which carries the compiler API';
