// SPDX-License-Identifier: EUPL-1.2
/**
 * Dry-run action builders for files deleted from a component workspace since
 * the last apply. Split out of `furnace-apply.ts` to stay under the per-file
 * line budget; the real undeploy paths stay in `furnace-apply-helpers.ts`.
 */

import { join } from 'node:path';

import type {
  CustomComponentConfig,
  DryRunAction,
  OverrideComponentConfig,
} from '../types/furnace.js';
import { getOverrideEngineTargetPath } from './furnace-apply-helpers.js';

/** Plans the engine-restore actions for deleted override workspace files. */
export function buildOverrideUndeployActions(
  name: string,
  config: OverrideComponentConfig,
  engineDir: string,
  deletedFiles: string[],
  ftlDir: string
): DryRunAction[] {
  return deletedFiles.map<DryRunAction>((fileName) => ({
    component: name,
    action: 'undeploy-restore',
    target: getOverrideEngineTargetPath(engineDir, config, fileName, ftlDir),
    description: `Restore engine/${
      fileName.endsWith('.ftl') ? `${ftlDir}/${fileName}` : `${config.basePath}/${fileName}`
    } to Firefox baseline`,
  }));
}

/** Plans the engine-removal + deregistration actions for deleted custom workspace files. */
export function buildCustomUndeployActions(
  name: string,
  config: CustomComponentConfig,
  engineDir: string,
  deletedFiles: string[],
  ftlDir: string
): DryRunAction[] {
  const actions: DryRunAction[] = [];
  for (const fileName of deletedFiles) {
    const enginePath = fileName.endsWith('.ftl')
      ? join(engineDir, ftlDir, fileName)
      : join(engineDir, config.targetPath, fileName);
    actions.push({
      component: name,
      action: 'undeploy-remove',
      target: enginePath,
      description: `Remove orphaned ${fileName} from engine`,
    });
  }
  // jar.mn re-sync planned for any custom-file deletion when registered.
  if (config.register && deletedFiles.some((f) => f.endsWith('.mjs') || f.endsWith('.css'))) {
    actions.push({
      component: name,
      action: 'unregister-jar',
      description: `Re-sync ${name} jar.mn entries to drop deleted files`,
    });
  }
  if (config.register && deletedFiles.some((f) => f === `${name}.mjs`)) {
    actions.push({
      component: name,
      action: 'unregister-ce',
      description: `Deregister ${name} from customElements.js (.mjs deleted)`,
    });
  }
  return actions;
}
