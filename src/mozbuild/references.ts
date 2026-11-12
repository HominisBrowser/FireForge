// SPDX-License-Identifier: EUPL-1.2
import { jarReferences } from './jar.js';
import { mozBuildReferences } from './mozbuild.js';
import { manifestKind, type ManifestReference } from './paths.js';
import { testManifestReferences } from './testManifest.js';

/**
 * The engine paths a manifest names, whatever its format: jar sources,
 * moz.build list items, or the tests and support files of a test manifest.
 * A path that is not a manifest, or an entry that names no engine path
 * (substitution, objdir, out-of-tree), yields nothing.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param text - Manifest text, or just the lines to read
 */
export function manifestReferences(manifestPath: string, text: string): ManifestReference[] {
  switch (manifestKind(manifestPath)) {
    case 'jar':
      return jarReferences(manifestPath, text);
    case 'moz-build':
      return mozBuildReferences(manifestPath, text);
    case 'test-manifest':
      return testManifestReferences(manifestPath, text);
    case undefined:
      return [];
  }
}

/**
 * Whether a manifest references an engine file: relative to the manifest's
 * directory (`../` included), from the engine root with `/` or `!/`, by
 * glob (`*`, `?`, `**`), or, for test-manifest support entries, as a
 * directory that covers everything beneath it.
 *
 * @param manifestPath - Engine-relative path of the manifest
 * @param text - Manifest text
 * @param file - Engine-relative path of the file
 */
export function manifestReferencesFile(manifestPath: string, text: string, file: string): boolean {
  return manifestReferences(manifestPath, text).some((reference) =>
    reference.matcher.matches(file)
  );
}
