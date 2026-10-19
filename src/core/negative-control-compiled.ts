// SPDX-License-Identifier: EUPL-1.2
/**
 * Which negative-control targets only a build can deliver.
 *
 * A control is applied after the pre-test build and right before dispatch,
 * which is right for a file the runtime reads from the source tree or the
 * objdir links to. A C++ (or Rust, IDL, …) source edited at that point is
 * never compiled: the run tests the unmutated binary and reports
 * `control=missed`, which reads as a test that cannot fail. Such a target
 * is now refused without `--build`, and with `--build` the control is
 * applied before the build so the binary under test carries it.
 */

import { extname } from 'node:path';

import { classifyRuntimeDelivery } from './objdir-install-manifests.js';
import { loadEngineInstallIndex } from './test-stale-exempt.js';

/** Extensions of sources the build compiles or code-generates into the binary. */
const COMPILED_EXTENSIONS = new Set([
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
 * The engine-relative targets that reach the runtime only through a
 * compile: a compiled-source extension and no install-manifest entry that
 * ships the file itself.
 *
 * @param engineDir - Absolute engine directory
 * @param enginePaths - The control's engine-relative targets
 */
export async function findCompiledControlTargets(
  engineDir: string,
  enginePaths: readonly string[]
): Promise<string[]> {
  const candidates = enginePaths.filter((path) => COMPILED_EXTENSIONS.has(extname(path)));
  if (candidates.length === 0) return [];
  const index = await loadEngineInstallIndex(engineDir);
  if (index === undefined) return candidates;
  const compiled: string[] = [];
  for (const path of candidates) {
    if ((await classifyRuntimeDelivery(index, engineDir, path)) === 'unlisted') {
      compiled.push(path);
    }
  }
  return compiled;
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
