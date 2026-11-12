// SPDX-License-Identifier: EUPL-1.2
/**
 * Moving a project to a new Firefox pin.
 *
 * Source mode merges every owned path three ways against the new pristine
 * commit and leaves conflicts as markers; `source.refreshPin` writes the new
 * pin with the merge, in one transaction.
 *
 * Patch mode replaces `engine/` with a checkout of the new pin, writes the
 * pin, and re-applies the queue with reduced context, rewriting every patch
 * against the new source. A patch that does not apply pauses the rebase
 * (`--continue`, `--abort`). The pin the rebase left is recorded in the
 * project state until the rebase completes, and an abort goes back to it:
 * `fireforge.json`, a checkout of that pin in `engine/`, and the queue
 * applied.
 */
import {
  type FirefoxConfig,
  type FirefoxProduct,
  inferFirefoxProduct,
  setConfigValue,
} from '../config/index.js';
import { ensurePristine, installProjectEngine, withEngineLock } from '../engine/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { s } from '../kernel/schema.js';
import {
  defineStateSection,
  loadProject,
  type PatchProject,
  type Project,
  readState,
  type SourceProject,
  updateState,
} from '../project/index.js';
import {
  importQueue,
  queueStatus,
  rebaseQueue,
  type RebaseResult,
  replayQueue,
  requirePatchMode,
} from '../queue/index.js';
import { refreshPin } from '../source/index.js';
import { pinnedPristine } from './pristine.js';

/** How {@link rebase} runs. */
export interface RebaseOptions {
  /** The Firefox version to move to. Patch mode without it rebases onto what `engine/` holds. */
  to?: string | undefined;
  /** The new version's product; default the current one when the version fits it, else by the version's shape. */
  product?: FirefoxProduct | undefined;
  /** Pinned digest of the new source archive. */
  sha256?: string | undefined;
  /** Release-candidate build directory of the new version, such as `build1`. */
  candidate?: string | undefined;
  /** Patch mode: resume a paused rebase from the fixed engine. */
  continue?: boolean | undefined;
  /** Patch mode: give up a paused rebase. */
  abort?: boolean | undefined;
  /** Patch mode: report whether the queue applies to the new source, changing nothing. */
  dryRun?: boolean | undefined;
  /** Patch mode: rebase over engine edits no patch has; a recovery snapshot keeps them. */
  force?: boolean | undefined;
  /** How long to wait for the engine lock, in milliseconds. */
  waitMs?: number | undefined;
  /** Receives download and import progress. */
  onProgress?: ((message: string) => void) | undefined;
}

/** What a rebase did. */
export type RebaseReport = {
  status: 'complete' | 'conflicts' | 'up-to-date' | 'dry-run' | 'aborted';
  /** The pin the project is on afterwards. */
  pin: { version: string; product: FirefoxProduct };
  /** Per patch (patch mode) or per owned path (source mode), what happened to it. */
  entries: { subject: string; outcome: string }[];
  /** Source mode: paths left with conflict markers. Dry run: the patch that does not apply. */
  conflicts: string[];
};

function usage(message: string, hint?: string): FireForgeError {
  return new FireForgeError('invalid-argument', message, {
    exitCode: ExitCode.INVALID_ARGUMENT,
    ...(hint === undefined ? {} : { hint }),
  });
}

/** The `firefox` block of the new pin: the current one's download policy, the new release. */
function newPin(project: Project, options: RebaseOptions & { to: string }): FirefoxConfig {
  const current = project.config.firefox;
  const inferred = inferFirefoxProduct(options.to);
  const product =
    options.product ??
    (inferred === 'firefox-beta' && current.product === 'firefox-devedition'
      ? current.product
      : inferred);
  return {
    version: options.to,
    product,
    allowUnverifiedDownload: current.allowUnverifiedDownload,
    ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }),
    ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
  };
}

function progress(options: RebaseOptions): { onProgress?: (message: string) => void } {
  return options.onProgress === undefined ? {} : { onProgress: options.onProgress };
}

/** The pin as `fireforge.json` holds it: defaults are not written out. */
function pinDocument(pin: FirefoxConfig): Record<string, unknown> {
  const { allowUnverifiedDownload, ...rest } = pin;
  return { ...rest, ...(allowUnverifiedDownload ? { allowUnverifiedDownload } : {}) };
}

async function rebaseSource(project: SourceProject, options: RebaseOptions): Promise<RebaseReport> {
  if ([options.continue, options.abort, options.dryRun, options.force].includes(true)) {
    throw usage(
      'A source-mode rebase is one merge: it has nothing to continue, abort, dry-run or force.',
      'Resolve the conflict markers and commit; "git restore" and "git clean" undo the merge.'
    );
  }
  if (options.to === undefined) throw usage('rebase needs the new version: --to <version>.');
  const pin = newPin(project, { ...options, to: options.to });
  const current = await pinnedPristine(project);
  const next = await ensurePristine(project.host, pin, progress(options));
  const result = await refreshPin(project, current, next, pinDocument(pin) as FirefoxConfig);
  return {
    status: result.conflicts.length > 0 ? 'conflicts' : 'complete',
    pin: { version: pin.version, product: pin.product },
    entries: result.paths.map((path) => ({
      subject: path.path,
      outcome: path.reason === undefined ? path.outcome : `${path.outcome} (${path.reason})`,
    })),
    conflicts: [...result.conflicts],
  };
}

/** The `firefox` block a patch-mode rebase moved away from, as `fireforge.json` held it. */
const originSection = defineStateSection(
  'rebaseOrigin',
  s.object({ firefox: s.string({ min: 1 }) }),
  'fireforge rebase --abort'
);

const reload = async (project: PatchProject): Promise<PatchProject> =>
  requirePatchMode(await loadProject(project.root, { FIREFORGE_HOME: project.host.root }));

/** Puts a patch-mode project's engine and configuration on a new pin. */
async function movePin(
  project: PatchProject,
  pin: FirefoxConfig,
  options: RebaseOptions
): Promise<PatchProject> {
  if (await exists(project.paths.engine)) {
    const status = await withEngineLock(
      project,
      { command: 'rebase', mode: 'shared', waitMs: options.waitMs },
      () => queueStatus(project)
    );
    if (status.session !== undefined) {
      throw new FireForgeError('session-active', `A ${status.session.kind} is paused.`, {
        exitCode: ExitCode.PATCH_ERROR,
        hint: `Finish it with "fireforge ${status.session.kind} --continue" or drop it with "fireforge rebase --abort".`,
      });
    }
    const unexported = status.paths.filter(
      (path) => path.state === 'modified' || path.state === 'unmanaged'
    );
    if (unexported.length > 0 && options.force !== true) {
      throw new FireForgeError(
        'engine-unexported-edits',
        `engine/ holds ${unexported.length} edit(s) no patch has, such as ${unexported[0]?.path ?? ''}; a rebase replaces the engine.`,
        {
          exitCode: ExitCode.PATCH_ERROR,
          hint: 'Capture them with "fireforge export" or "fireforge re-export", drop them with "fireforge discard", or pass --force (a recovery snapshot keeps them).',
        }
      );
    }
  }
  const interrupted = await readState(project, originSection);
  if (interrupted !== undefined) {
    throw new FireForgeError(
      'rebase-interrupted',
      `A rebase away from ${interrupted.firefox} did not finish.`,
      {
        exitCode: ExitCode.PATCH_ERROR,
        hint: 'Go back to that version with "fireforge rebase --abort", or finish with "fireforge rebase --continue".',
      }
    );
  }
  const pristine = await ensurePristine(project.host, pin, progress(options));
  await updateState(project, originSection, () => ({
    firefox: JSON.stringify(pinDocument(project.config.firefox)),
  }));
  await installProjectEngine(project, pristine, { force: true, waitMs: options.waitMs });
  await setConfigValue(project.root, 'firefox', JSON.stringify(pinDocument(pin)));
  return reload(project);
}

/**
 * Takes an aborted rebase back to the pin it started from: the configuration,
 * a checkout of that pin, and the queue applied to it. A rebase that changed
 * no pin has nothing to go back to.
 */
async function restoreOrigin(project: PatchProject, options: RebaseOptions): Promise<PatchProject> {
  const origin = await readState(project, originSection);
  if (origin === undefined) return project;
  await setConfigValue(project.root, 'firefox', origin.firefox);
  const restored = await reload(project);
  const pristine = await ensurePristine(restored.host, restored.config.firefox, progress(options));
  await installProjectEngine(restored, pristine, { force: true, waitMs: options.waitMs });
  await withEngineLock(restored, { command: 'rebase', waitMs: options.waitMs }, () =>
    importQueue(restored)
  );
  await updateState(restored, originSection, () => undefined);
  return restored;
}

async function rebasePatches(project: PatchProject, options: RebaseOptions): Promise<RebaseReport> {
  const resuming = options.continue === true || options.abort === true;
  if (resuming && options.to !== undefined) {
    throw usage('--to starts a rebase; --continue and --abort act on the paused one.');
  }
  const pin =
    options.to === undefined ? undefined : newPin(project, { ...options, to: options.to });
  if (pin !== undefined && options.dryRun === true) {
    const pristine = await ensurePristine(project.host, pin, progress(options));
    const failure = await replayQueue(pristine.repo, pristine.commit, project.paths.patches).then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof FireForgeError && error.code === 'queue-does-not-apply') return error;
        throw error;
      }
    );
    return {
      status: 'dry-run',
      pin: { version: pin.version, product: pin.product },
      entries: [],
      conflicts: failure === undefined ? [] : [failure.message],
    };
  }
  const target = pin === undefined ? project : await movePin(project, pin, options);
  const result = await withEngineLock(target, { command: 'rebase', waitMs: options.waitMs }, () =>
    rebaseQueue(target, {
      ...(options.continue === true ? { continue: true } : {}),
      ...(options.abort === true ? { abort: true } : {}),
      ...(options.dryRun === true ? { dryRun: true } : {}),
      ...(options.force === true ? { force: true } : {}),
    })
  ).catch(async (error: unknown): Promise<RebaseResult> => {
    // A rebase interrupted before its queue was applied has no paused session, only its origin.
    const unapplied =
      options.abort === true &&
      error instanceof FireForgeError &&
      error.code === 'no-session' &&
      (await readState(target, originSection)) !== undefined;
    if (!unapplied) throw error;
    return { status: 'aborted', patches: [], written: [], emptied: [] };
  });
  const settled = options.abort === true ? await restoreOrigin(target, options) : target;
  if (result.status === 'complete' || result.status === 'up-to-date') {
    await updateState(target, originSection, () => undefined);
  }
  const { version, product } = settled.config.firefox;
  return {
    status: result.status,
    pin: { version, product },
    entries: result.patches.map((patch) => ({
      subject: patch.patch,
      outcome: result.emptied.includes(patch.patch) ? 'emptied' : patch.status,
    })),
    conflicts: result.patches.flatMap((patch) =>
      patch.conflicts === undefined || patch.conflicts.length === 0 ? [] : [patch.patch]
    ),
  };
}

/**
 * Moves the project to a new Firefox pin (see the module comment).
 *
 * @param project - The project
 * @param options - See {@link RebaseOptions}
 * @throws `invalid-argument` for options the mode has no meaning for; the
 *   download errors of the engine module; in patch mode the paused-session
 *   error naming the patch that did not apply, `engine-unexported-edits`;
 *   in source mode `refresh-dirty` and `refresh-pin-unchanged`
 */
export async function rebase(project: Project, options: RebaseOptions = {}): Promise<RebaseReport> {
  if (options.to === project.config.firefox.version && options.product === undefined) {
    throw usage(`The project is already on Firefox ${options.to}.`);
  }
  return project.mode === 'source'
    ? rebaseSource(project, options)
    : rebasePatches(project, options);
}
