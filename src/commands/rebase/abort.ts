// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase abort flow.
 */

import { getProjectPaths, updateState } from '../../core/config.js';
import { clearAppliedFurnaceState } from '../../core/furnace-config.js';
import { resetChanges } from '../../core/git.js';
import {
  clearRebaseSession,
  getRebaseSessionPath,
  readRebaseSession,
} from '../../core/rebase-session.js';
import { NoRebaseSessionError } from '../../errors/rebase.js';
import { intro, outro, spinner, success, warn } from '../../utils/logger.js';
import { confirmDirtyEngineReset } from './confirm.js';

/**
 * Handles `fireforge rebase --abort`.
 */
export async function handleAbort(projectRoot: string, yes?: boolean): Promise<void> {
  intro('FireForge Rebase — Abort');

  // Abort is the escape hatch, so it deliberately does NOT require a *valid*
  // session — only that one is present. Nothing below reads the session
  // object (the restore works off `paths.engine` and `resetChanges`), and an
  // `if (!session) throw` would refuse to run against a corrupt file, which
  // is the only thing that could have cleared it.
  const read = await readRebaseSession(projectRoot);
  if (!read.present) throw new NoRebaseSessionError();
  if (!read.valid) {
    warn(
      `The rebase session at ${getRebaseSessionPath(projectRoot)} is unreadable ` +
        `(${read.reason}). Aborting anyway: the engine will be restored and the session cleared.`
    );
  }

  const paths = getProjectPaths(projectRoot);

  if (
    !(await confirmDirtyEngineReset({
      engineDir: paths.engine,
      yes: yes ?? false,
      nonInteractiveCommand: 'fireforge rebase --abort --yes',
      argumentName: '--yes',
      warningMessage: 'The engine directory has uncommitted changes that will be lost.',
      promptMessage: 'Discard uncommitted changes and abort rebase?',
      cancelMessage: 'Abort cancelled',
    }))
  ) {
    return;
  }

  const s = spinner('Restoring engine to pre-rebase state...');

  // Step 1: git reset. If this fails, the rebase session MUST stay on disk
  // so the user can retry the abort — resetChanges is the only irreversible
  // operation in this handler and everything downstream assumes it ran.
  try {
    await resetChanges(paths.engine);
    s.stop('Engine restored');
  } catch (error: unknown) {
    s.error('Failed to restore engine');
    throw error;
  }

  // Step 2: clear Furnace state. A failure here is reported on its own
  // (rather than labelled "Failed to restore engine", which would be
  // misleading now that reset already succeeded). The rebase session is
  // still kept on disk so the user can retry the abort and let it
  // idempotently re-clear furnace state.
  await clearAppliedFurnaceState(projectRoot);

  // Step 3: clear pending resolution transactionally.
  await updateState(projectRoot, (current) => {
    if (!current.pendingResolution) return current;
    const next = { ...current };
    delete next.pendingResolution;
    return next;
  });

  // Step 4: clear the rebase session LAST so a failure in any prior step
  // preserves the session on disk and a retry of --abort can succeed.
  await clearRebaseSession(projectRoot);
  success('Rebase aborted and session cleared.');
  outro('Rebase aborted');
}
