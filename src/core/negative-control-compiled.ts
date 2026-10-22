// SPDX-License-Identifier: EUPL-1.2
/**
 * Which negative-control targets only a build can deliver.
 *
 * A control is applied after the pre-test build and right before dispatch,
 * which is right for a file the runtime reads from the source tree or the
 * objdir links to. A C++ (or Rust, IDL, …) source edited at that point is
 * never compiled: the run tests the unmutated binary and reports
 * `control=missed`, which reads as a test that cannot fail. Such a target
 * is refused without `--build`, and with `--build` the control is
 * applied before the build so the binary under test carries it. That build
 * is a full `mach build`: the pre-test build is otherwise `mach build
 * faster`, which compiles nothing, so the control would still miss.
 */

import { extname } from 'node:path';

import { classifyRuntimeDelivery } from './objdir-install-manifests.js';
import { loadEngineInstallIndex } from './test-stale-exempt.js';

/** Extensions of sources the build compiles or code-generates into the binary. */
const COMPILED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.m',
  '.mm',
  '.rs',
  '.idl',
  '.webidl',
  '.ipdl',
  '.ipdlh',
  '.yaml',
  '.yml',
]);

/**
 * Header extensions. An `EXPORTS` install manifest names many headers (it
 * copies them into `dist/include`), but that copy only feeds other
 * compiles: the runtime never reads a header, so a header edit reaches the
 * binary through a compile whatever the manifests say.
 */
const HEADER_EXTENSIONS: ReadonlySet<string> = new Set(['.h', '.hh', '.hpp', '.ipdlh']);

/**
 * Whether an engine-relative path has a compiled-source extension: a file
 * the build compiles or code-generates into the binary. This is the
 * extension test only. {@link findCompiledControlTargets} additionally
 * drops non-header files an install manifest ships as-is.
 *
 * @param path - Engine-relative path
 */
export function isCompiledSourcePath(path: string): boolean {
  return COMPILED_EXTENSIONS.has(extname(path));
}

/**
 * The engine-relative targets that reach the runtime only through a
 * compile: a compiled-source extension and no install-manifest entry that
 * ships the file itself. Headers are always compiled, even when an
 * `EXPORTS` manifest installs them into `dist/include`.
 *
 * @param engineDir - Absolute engine directory
 * @param enginePaths - The control's engine-relative targets
 */
export async function findCompiledControlTargets(
  engineDir: string,
  enginePaths: readonly string[]
): Promise<string[]> {
  const candidates = enginePaths.filter(isCompiledSourcePath);
  if (candidates.length === 0) return [];
  if (candidates.every((path) => HEADER_EXTENSIONS.has(extname(path)))) return candidates;
  const index = await loadEngineInstallIndex(engineDir);
  if (index === undefined) return candidates;
  const compiled: string[] = [];
  for (const path of candidates) {
    if (
      HEADER_EXTENSIONS.has(extname(path)) ||
      (await classifyRuntimeDelivery(index, engineDir, path)) === 'unlisted'
    ) {
      compiled.push(path);
    }
  }
  return compiled;
}

/**
 * The notice that explains why a compiled control's pre-test build is a
 * full `mach build` instead of `mach build faster`.
 *
 * @param compiled - Engine-relative compiled targets
 */
export function formatCompiledControlBuildNotice(compiled: readonly string[]): string {
  const files = compiled.map((path) => `engine/${path}`).join(', ');
  return (
    `The negative control edits compiled source (${files}); escalating this pre-test build to ` +
    'a full mach build, since mach build faster compiles nothing and the binary under test ' +
    'would not carry the control.'
  );
}

/**
 * The refusal for a compiled control without `--build`, naming the manual
 * procedure for a run that wants to keep its build out of FireForge.
 *
 * @param compiled - Engine-relative compiled targets
 */
export function formatCompiledControlRefusal(compiled: readonly string[]): string {
  const files = compiled.map((path) => `engine/${path}`).join(', ');
  return (
    `This negative control edits compiled source (${files}). Applied right before dispatch, ` +
    'it would never be compiled: the run would test the unmutated binary and report ' +
    'control=missed. Add --build: the control is then applied before the pre-test build, so ' +
    'the binary under test carries it, and restored afterwards with a fresh mtime so the next ' +
    'build recompiles the original. To run it by hand instead: copy the mutated file in, ' +
    '`touch` it, `fireforge build`, `fireforge test`, restore the file byte-exact, `touch` it ' +
    'again and rebuild.'
  );
}
