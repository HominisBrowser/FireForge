// SPDX-License-Identifier: EUPL-1.2
import {
  operatorAlreadySetAppPath,
  resolveXpcshellAppdirArg,
  type XpcshellAppdirOutcome,
} from '../core/xpcshell-appdir.js';
import { info, warn } from '../utils/logger.js';

/**
 * Resolves and appends an xpcshell `--app-path=<abs>` argument when the
 * selected manifest requests a browser appdir that rebranded forks otherwise
 * fail to discover.
 */
export async function maybeInjectAppdirArg(
  engineDir: string,
  normalizedPaths: readonly string[],
  objDir: string | undefined,
  extraArgs: string[]
): Promise<boolean> {
  if (!objDir) return false;
  if (operatorAlreadySetAppPath(extraArgs)) return false;
  const outcome: XpcshellAppdirOutcome = await resolveXpcshellAppdirArg(
    engineDir,
    normalizedPaths,
    objDir
  );
  switch (outcome.kind) {
    case 'none':
      return false;
    case 'mismatch':
      warn(
        `xpcshell appdir auto-injection skipped — multiple test paths resolved to different app dirs (${outcome.values.join(', ')}). Pass --mach-arg=--app-path=<abs> to disambiguate.`
      );
      return false;
    case 'unresolved':
      warn(
        `xpcshell appdir auto-injection skipped — manifest at ${outcome.manifestPath} requests appdir "${outcome.relativeAppdir}" but no matching directory exists under ${objDir}/dist/. Build artifacts may be stale.`
      );
      return false;
    case 'injected':
      extraArgs.push(`--app-path=${outcome.result.appPath}`);
      info(
        `xpcshell appdir auto-injected: --app-path=${outcome.result.appPath} (from ${outcome.result.manifestPath} firefox-appdir=${outcome.result.relativeAppdir}).`
      );
      return true;
  }
}
