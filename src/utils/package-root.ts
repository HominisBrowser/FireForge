// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getNodeErrorCode, toError } from './errors.js';
import { parseObject } from './parse.js';
import { isObject } from './validation.js';

interface PackageMetadata {
  name: string;
  version: string;
  bin?: unknown;
}

function readPackageMetadata(filePath: string): PackageMetadata {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseObject(JSON.parse(raw), 'package.json');
  return { name: parsed.string('name'), version: parsed.string('version'), bin: parsed.raw('bin') };
}

let cachedPackageRoot: string | undefined;

/**
 * Finds the fireforge package root by walking up from the current module.
 *
 * Works from both the source tree (`src/utils/`) and the compiled
 * tree (`dist/src/utils/`) by looking for a `package.json` that exposes
 * the `fireforge` CLI entrypoint, regardless of the npm package scope.
 *
 * The result is cached after the first call since it is deterministic
 * within a process.
 */
export function getPackageRoot(): string {
  if (cachedPackageRoot !== undefined) {
    return cachedPackageRoot;
  }

  let current = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const packagePath = join(current, 'package.json');
    try {
      const pkg = readPackageMetadata(packagePath);
      if (isFireForgePackageMetadata(pkg)) {
        cachedPackageRoot = current;
        return current;
      }
    } catch (error: unknown) {
      // Absent package.json: keep walking. A package.json that exists but
      // fails to parse is a different case: walking past it could bind
      // to a wrong ancestor package (any parent exposing bin.fireforge) or
      // end in the unhelpful generic "could not locate" error, hiding the
      // actual syntax problem.
      const code = getNodeErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`Found ${packagePath} but could not parse it: ` + toError(error).message, {
          cause: error,
        });
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error('Could not locate the fireforge package root');
    }
    current = parent;
  }
}

/** @internal */
export function isFireForgePackageMetadata(pkg: PackageMetadata): boolean {
  if (!isObject(pkg.bin)) {
    return false;
  }

  const bin = pkg.bin;
  return typeof bin['fireforge'] === 'string';
}

/** Reads the current package version from the repository root package manifest. */
export function getPackageVersion(): string {
  const packageRoot = getPackageRoot();
  return readPackageMetadata(join(packageRoot, 'package.json')).version;
}
