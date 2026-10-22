// SPDX-License-Identifier: EUPL-1.2
/**
 * Facts about the launchable build a test run will exercise: its build id
 * and when its compiled code was last linked.
 *
 * A green or red against a binary older than the C++ under test reads as a
 * verdict on that C++ unless the run says which binary it was. The
 * build id goes on the verdict line (`build-id=`), and the link time anchors
 * the stale-compiled preflight (`findCompiledSourcesNewerThanBinary` in
 * `test-stale-check.ts`).
 */

import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { getNodeErrorCode, toError } from '../utils/errors.js';
import { readText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';

/**
 * The compiled libraries a build links next to the launchable binary.
 * `libxul` carries nearly all compiled engine code (C++, Rust, generated
 * bindings, prefs), so it, not the small launcher executable, is what a
 * compiled-source edit relinks.
 */
const LINKED_LIBRARY_NAMES = ['XUL', 'libxul.so', 'xul.dll'];

/**
 * The `application.ini` beside a launchable binary: `Contents/Resources`
 * of the `.app` bundle on macOS, the binary's own directory (`dist/bin`)
 * elsewhere.
 *
 * @param binaryPath - Absolute launchable binary path
 */
export function applicationIniPath(binaryPath: string): string {
  const binaryDir = dirname(binaryPath);
  if (basename(binaryDir) === 'MacOS' && basename(dirname(binaryDir)) === 'Contents') {
    return join(dirname(binaryDir), 'Resources', 'application.ini');
  }
  return join(binaryDir, 'application.ini');
}

/**
 * Reads the `BuildID=` of the launchable build (the `moz:buildID` the
 * browser reports). Undefined when the file or the key is missing, so a
 * caller can simply leave the attribute off.
 *
 * @param engineDir - Absolute engine directory
 * @param launchablePath - Engine-relative launchable binary path
 */
export async function readBuildId(
  engineDir: string,
  launchablePath: string
): Promise<string | undefined> {
  const iniPath = applicationIniPath(join(engineDir, launchablePath));
  let content: string;
  try {
    content = await readText(iniPath);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') {
      verbose(`Build id: could not read ${iniPath} — ${toError(error).message}`);
    }
    return undefined;
  }
  const match = /^BuildID=(\S+)\s*$/m.exec(content);
  return match?.[1];
}

/**
 * When the launchable build's compiled code was last linked: the newest
 * mtime of the binary and the `libxul` beside it. Undefined when neither
 * can be read.
 *
 * @param engineDir - Absolute engine directory
 * @param launchablePath - Engine-relative launchable binary path
 */
export async function readLinkedAt(
  engineDir: string,
  launchablePath: string
): Promise<{ mtimeMs: number; path: string } | undefined> {
  const binary = join(engineDir, launchablePath);
  const candidates = [binary, ...LINKED_LIBRARY_NAMES.map((name) => join(dirname(binary), name))];
  let newest: { mtimeMs: number; path: string } | undefined;
  for (const path of candidates) {
    try {
      // stat follows the dist/bin symlinks to the linked objdir file.
      const { mtimeMs } = await stat(path);
      if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { mtimeMs, path };
    } catch {
      // A platform's other library names are simply absent.
    }
  }
  return newest;
}
