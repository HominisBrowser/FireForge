// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageMetadata {
  name: string;
  version: string;
}

function validatePackageMetadata(data: unknown, filePath: string): PackageMetadata {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Invalid package metadata in ${filePath}: expected an object`);
  }

  const name = 'name' in data ? data.name : undefined;
  const version = 'version' in data ? data.version : undefined;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(
      `Invalid package metadata in ${filePath}: expected string "name" and "version" fields`
    );
  }

  return { name, version };
}

function readPackageMetadata(filePath: string): PackageMetadata {
  const raw = readFileSync(filePath, 'utf-8');
  return validatePackageMetadata(JSON.parse(raw), filePath);
}

/**
 * Finds the fireforge package root by walking up from the current module.
 *
 * Works from both the source tree (`src/utils/`) and the compiled
 * tree (`dist/src/utils/`) by looking for a `package.json` whose
 * `name` field is `"@hominis/fireforge"`.
 */
export function getPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    try {
      const packagePath = join(current, 'package.json');
      const pkg = readPackageMetadata(packagePath);
      if (pkg.name === '@hominis/fireforge') {
        return current;
      }
    } catch (error: unknown) {
      void error;
      // no package.json here — keep walking
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error('Could not locate the fireforge package root');
    }
    current = parent;
  }
}

/** Reads the current package version from the repository root package manifest. */
export function getPackageVersion(): string {
  const packageRoot = getPackageRoot();
  return readPackageMetadata(join(packageRoot, 'package.json')).version;
}
