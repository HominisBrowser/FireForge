// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase abort flow.
 */

import { getProjectPaths, loadState, saveState } from '../../core/config.js';
import { getFurnacePaths, updateFurnaceState } from '../../core/furnace-config.js';
import { resetChanges } from '../../core/git.js';
import { clearRebaseSession, loadRebaseSession } from '../../core/rebase-session.js';
import { NoRebaseSessionError } from '../../errors/rebase.js';
import { pathExists } from '../../utils/fs.js';
import { intro, outro, spinner, success } from '../../utils/logger.js';
import { confirmDirtyEngineReset } from './confirm.js';

/**
 * Handles `fireforge rebase --abort`.
 */
export async function handleAbort(projectRoot: string, yes?: boolean): Promise<void> {
  intro('FireForge Rebase — Abort');

  const session = await loadRebaseSession(projectRoot);
  if (!session) throw new NoRebaseSessionError();

  const paths = getProjectPaths(projectRoot);

  if (
    !(await confirmDirtyEngineReset({
      engineDir: paths.engine,
      yes: yes ?? false,
      nonInteractiveHint: 'Use: fireforge rebase --abort --yes',
      warningMessage: 'The engine directory has uncommitted changes that will be lost.',
      promptMessage: 'Discard uncommitted changes and abort rebase?',
      cancelMessage: 'Abort cancelled',
    }))
  ) {
    return;
  }

  const s = spinner('Restoring engine to pre-rebase state...');

  try {
    await resetChanges(paths.engine);
    s.stop('Engine restored');

    // Clear Furnace state — the engine has been rolled back to pre-rebase state.
    const furnacePaths = getFurnacePaths(projectRoot);
    if (await pathExists(furnacePaths.furnaceState)) {
      await updateFurnaceState(projectRoot, (current) => ({
        ...(current.pendingRepair ? { pendingRepair: current.pendingRepair } : {}),
      }));
    }
  } catch (error: unknown) {
    s.error('Failed to restore engine');
    throw error;
  }

  // Clear pending resolution state if any
  const state = await loadState(projectRoot);
  if (state.pendingResolution) {
    delete state.pendingResolution;
    await saveState(projectRoot, state);
  }

  await clearRebaseSession(projectRoot);
  success('Rebase aborted and session cleared.');
  outro('Rebase aborted');
}
