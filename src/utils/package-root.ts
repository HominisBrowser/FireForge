// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageMetadata {
  name: string;
  version: string;
  bin?: unknown;
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

  return { name, version, bin: 'bin' in data ? data.bin : undefined };
}

function readPackageMetadata(filePath: string): PackageMetadata {
  const raw = readFileSync(filePath, 'utf-8');
  return validatePackageMetadata(JSON.parse(raw), filePath);
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
    try {
      const packagePath = join(current, 'package.json');
      const pkg = readPackageMetadata(packagePath);
      if (isFireForgePackageMetadata(pkg)) {
        cachedPackageRoot = current;
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

/** Clears the cached package root for testing. */
export function resetPackageRootCacheForTests(): void {
  cachedPackageRoot = undefined;
}

/** @internal */
export function isFireForgePackageMetadata(pkg: PackageMetadata): boolean {
  if (typeof pkg.bin !== 'object' || pkg.bin === null || Array.isArray(pkg.bin)) {
    return false;
  }

  const bin = pkg.bin as Record<string, unknown>;
  return typeof bin['fireforge'] === 'string';
}

/** Reads the current package version from the repository root package manifest. */
export function getPackageVersion(): string {
  const packageRoot = getPackageRoot();
  return readPackageMetadata(join(packageRoot, 'package.json')).version;
}
