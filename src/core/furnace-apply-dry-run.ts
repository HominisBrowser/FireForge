// SPDX-License-Identifier: EUPL-1.2
/**
 * Dry-run action planning for custom-component apply. Extracted from
 * `furnace-apply-helpers.ts` so the apply path and its dry-run mirror each
 * stay within the per-file line budget. Consumed only by that module.
 */

import { join } from 'node:path';

import type {
  ComponentApplyContext,
  CustomComponentConfig,
  DryRunAction,
  StepError,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { describeLocaleFtlJarMnRegistration, describeSharedFtlPrune } from './furnace-apply-ftl.js';
import { describeFragmentExpansion } from './furnace-css-fragments.js';
import { type DirectoryEntry, isRegularFile } from './furnace-dir-entry.js';
import {
  validateCustomElementRegistration,
  validateJarMnInsertionForFiles,
} from './furnace-registration.js';

/** Computes the planned dry-run actions (and pre-flight step errors) for a custom component. */
export async function buildCustomDryRunActions(
  ctx: Pick<ComponentApplyContext, 'engineDir' | 'name' | 'componentDir' | 'ftlDir'>,
  config: CustomComponentConfig,
  targetDir: string,
  entries: DirectoryEntry[]
): Promise<{ actions: DryRunAction[]; stepErrors: StepError[] }> {
  const { engineDir, name, componentDir, ftlDir } = ctx;
  const actions: DryRunAction[] = [];
  const stepErrors: StepError[] = [];

  for (const entry of entries) {
    if (!isRegularFile(entry)) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.css')) continue;
    const fragmentNote = await describeFragmentExpansion(join(componentDir, entry.name));
    actions.push({
      component: name,
      action: fragmentNote ? 'expand-fragments' : 'copy',
      source: join(componentDir, entry.name),
      target: join(targetDir, entry.name),
      description: `Copy ${entry.name} to ${config.targetPath}${fragmentNote}`,
    });
  }

  // Per-component .ftl handling is skipped when the component opts into a
  // shared feature-scoped bundle via `sharedFtl`. The shared file is
  // registered (and copied) by whoever owns the feature bundle, so
  // emitting a copy-ftl / register-jar action here would duplicate (or
  // later orphan) the entry.
  if (config.localized && !config.sharedFtl) {
    const ftlFile = `${name}.ftl`;
    const ftlSrc = join(componentDir, ftlFile);
    if (await pathExists(ftlSrc)) {
      actions.push({
        component: name,
        action: 'copy-ftl',
        source: ftlSrc,
        target: join(engineDir, ftlDir, ftlFile),
        description: `Copy ${ftlFile} to ${ftlDir}`,
      });

      const localeAction = describeLocaleFtlJarMnRegistration(name, ftlDir, ftlFile);
      if (localeAction) {
        actions.push(localeAction);
      }
    }
  }

  // A sharedFtl widget owns its strings via the shared bundle; surface the
  // removal of any dangling per-widget locale jar.mn entry so the dry-run
  // plan matches what apply will do (and explains the unblocked build).
  const pruneAction = await describeSharedFtlPrune(ctx, config);
  if (pruneAction) {
    actions.push(pruneAction);
  }

  if (config.register) {
    try {
      const modulePath = `chrome://global/content/elements/${name}.mjs`;
      await validateCustomElementRegistration(engineDir, name, modulePath);
    } catch (error: unknown) {
      stepErrors.push({
        step: 'customElements.js registration',
        error: toError(error).message,
      });
    }
    actions.push({
      component: name,
      action: 'register-ce',
      description: `Register ${name} in customElements.js (DOMContentLoaded block)`,
    });
  }

  const copiedFileNames = entries
    .filter(
      (entry) =>
        isRegularFile(entry) && (entry.name.endsWith('.mjs') || entry.name.endsWith('.css'))
    )
    .map((entry) => entry.name);

  if (copiedFileNames.length > 0) {
    try {
      await validateJarMnInsertionForFiles(engineDir, name, copiedFileNames);
    } catch (error: unknown) {
      stepErrors.push({
        step: 'jar.mn registration',
        error: toError(error).message,
      });
    }
    actions.push({
      component: name,
      action: 'register-jar',
      description: `Add ${copiedFileNames.join(', ')} to jar.mn`,
    });
  }

  return { actions, stepErrors };
}
