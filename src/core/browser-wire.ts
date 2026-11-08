// SPDX-License-Identifier: EUPL-1.2
import { join, relative } from 'node:path';

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { toRootRelativePath } from '../utils/paths.js';
import { normalizePathSlashes } from '../utils/paths.js';
import { authoredImage, authoredTargetForFile } from './authored/write-lock.js';
import { authoringProjectPaths } from './authored/writer.js';
import { loadConfig } from './config.js';
import {
  completeJournalRollback,
  type FurnaceOperationContext,
  runFurnaceMutation,
} from './furnace-operation.js';
import { assertSnapshotted, createRollbackJournal, snapshotFile } from './furnace-rollback.js';
import type { RegisterResult } from './moz-manifest-register.js';
import { registerBrowserContent } from './moz-manifest-register.js';
import { addDestroyToBrowserInit } from './wire-destroy.js';
import { addDomFragment, DEFAULT_DOM_TARGET } from './wire-dom-fragment.js';
import { addInitToBrowserInit } from './wire-init.js';
import { addSubscriptToBrowserMain } from './wire-subscript.js';

export const DEFAULT_BROWSER_SUBSCRIPT_DIR = 'browser/base/content';
const BROWSER_BASE_DIR = 'browser/base';

/**
 * Result of a wire operation.
 */
export interface WireResult {
  /** Whether the subscript was added to browser-main.js */
  subscriptAdded: boolean;
  /** Whether the init expression was added to browser-init.js */
  initAdded: boolean;
  /** Whether the destroy expression was added to browser-init.js */
  destroyAdded: boolean;
  /** Whether the DOM fragment was inserted into browser.xhtml */
  domInserted: boolean;
  /** Result of jar.mn registration */
  jarMnResult: RegisterResult;
}

export interface WireOptions {
  /** Init expression to add to browser-init.js onLoad() */
  init?: string | undefined;
  /** Destroy expression to add to browser-init.js onUnload() */
  destroy?: string | undefined;
  /** Path to `.inc.xhtml` file relative to engine root */
  domFilePath?: string | undefined;
  /**
   * Top-level chrome document the DOM fragment's `#include` directive is
   * inserted into, relative to engine/. Defaults to
   * `browser/base/content/browser.xhtml`. Forks that replace browser.xhtml
   * with a custom chrome document (e.g. `mybrowser.xhtml`) pass the
   * replacement path here.
   */
  domTargetPath?: string | undefined;
  /** Dry run: don't write any files */
  dryRun?: boolean | undefined;
  /** Insert init block after the block containing this name */
  after?: string | undefined;
  /** Subscript directory relative to engine/ (default: "browser/base/content") */
  subscriptDir?: string | undefined;
}

/**
 * Wires a chrome subscript into the browser.
 *
 * @param root - Project root directory
 * @param name - Subscript name (without .js extension)
 * @param options - Wire options
 * @returns Wire result
 */
async function wireSubscriptWithin(
  root: string,
  name: string,
  options: WireOptions,
  ctx: FurnaceOperationContext
): Promise<WireResult> {
  const { engine: engineDir } = await authoringProjectPaths(root);
  const subscriptDir = toRootRelativePath(
    engineDir,
    options.subscriptDir ?? DEFAULT_BROWSER_SUBSCRIPT_DIR
  );

  // Compute jar.mn source path relative to browser/base/
  let jarMnSourcePath: string | undefined;
  if (subscriptDir !== DEFAULT_BROWSER_SUBSCRIPT_DIR) {
    const relPath = normalizePathSlashes(
      relative(join(engineDir, BROWSER_BASE_DIR), join(engineDir, subscriptDir))
    );
    jarMnSourcePath = `${relPath}/${name}.js`;
  }

  if (options.dryRun) {
    return {
      subscriptAdded: true,
      initAdded: !!options.init,
      destroyAdded: !!options.destroy,
      domInserted: !!options.domFilePath,
      jarMnResult: {
        manifest: 'browser/base/jar.mn',
        entry: `[dry-run] Would register content/browser/${name}.js`,
        skipped: false,
      },
    };
  }

  // Snapshot every file the five mutation steps might touch so a
  // mid-sequence failure (most commonly the chrome-document insertion not
  // finding an anchor) does not leave a half-wired browser behind: new
  // `loadSubScript` calls in browser-main.js, new init/destroy expressions
  // in browser-init.js, and a new entry in browser/base/jar.mn, with no way
  // back but a hand-revert or a re-download. Init/destroy/DOM are
  // conditional, so those targets are snapshotted only when the
  // corresponding option would fire a write.
  const journal = createRollbackJournal();
  journal.conditionalLegacy = true;
  ctx.registerJournal(journal);
  const completedWrite = async (path: string): Promise<void> => {
    // Authored publications are attributed atomically by the source writer. The
    // shared Furnace lock serializes these legacy adapter steps instead.
    if (await authoredTargetForFile(path)) return;
    const snapshot = journal.files.get(path);
    if (snapshot) snapshot.postimage = await authoredImage(path);
  };
  const effectiveDomTargetPath = options.domFilePath
    ? toRootRelativePath(engineDir, options.domTargetPath ?? DEFAULT_DOM_TARGET)
    : undefined;

  await snapshotFile(journal, join(engineDir, 'browser/base/content/browser-main.js'));
  if (options.init !== undefined || options.destroy !== undefined) {
    await snapshotFile(journal, join(engineDir, 'browser/base/content/browser-init.js'));
  }
  if (effectiveDomTargetPath) {
    await snapshotFile(journal, join(engineDir, effectiveDomTargetPath));
  }
  await snapshotFile(journal, join(engineDir, 'browser/base/jar.mn'));

  // Compute the project-scoped patch-lint marker (`// <BINARY>:`) so every
  // wire mutator can stamp it into the emitted comment block. Without it,
  // `lintModificationComments` trips `missing-modification-comment` on
  // wire-generated edits the next time the operator exports. A broken config
  // should not block the wire, so the fallback marker keeps the
  // lint-friendly default when the config cannot be loaded.
  let marker = 'FIREFORGE:';
  try {
    const config = await loadConfig(root);
    marker = `${config.binaryName.toUpperCase()}:`;
  } catch (error: unknown) {
    verbose(
      `Using default wire marker because fireforge.json could not be loaded: ${toError(error).message}`
    );
  }

  try {
    // 1. Add subscript to browser-main.js
    assertSnapshotted(
      journal,
      join(engineDir, 'browser/base/content/browser-main.js'),
      'browser wire'
    );
    const subscriptAdded = await addSubscriptToBrowserMain(engineDir, name, marker);
    if (subscriptAdded)
      await completedWrite(join(engineDir, 'browser/base/content/browser-main.js'));

    // 2. Add init expression to browser-init.js (if provided)
    let initAdded = false;
    if (options.init) {
      // The snapshot above is taken when init or destroy is `!== undefined`
      // while these writes fire on truthiness. Close, but two separate
      // conditions over the same file, and that kind of pairing drifts when
      // a third writer is added later.
      assertSnapshotted(
        journal,
        join(engineDir, 'browser/base/content/browser-init.js'),
        'browser wire init'
      );
      initAdded = await addInitToBrowserInit(engineDir, options.init, options.after, marker);
      if (initAdded) await completedWrite(join(engineDir, 'browser/base/content/browser-init.js'));
    }

    // 3. Add destroy expression to browser-init.js onUnload() (if provided)
    let destroyAdded = false;
    if (options.destroy) {
      assertSnapshotted(
        journal,
        join(engineDir, 'browser/base/content/browser-init.js'),
        'browser wire destroy'
      );
      destroyAdded = await addDestroyToBrowserInit(engineDir, options.destroy, marker);
      if (destroyAdded)
        await completedWrite(join(engineDir, 'browser/base/content/browser-init.js'));
    }

    // 4. Add #include directive to the top-level chrome document (if provided)
    let domInserted = false;
    if (options.domFilePath) {
      domInserted = await addDomFragment(
        engineDir,
        toRootRelativePath(engineDir, options.domFilePath),
        options.domTargetPath
      );
      if (domInserted && effectiveDomTargetPath)
        await completedWrite(join(engineDir, effectiveDomTargetPath));
    }

    // 5. Register in jar.mn
    assertSnapshotted(journal, join(engineDir, 'browser/base/jar.mn'), 'browser wire jar.mn');
    const jarMnResult = await registerBrowserContent(
      engineDir,
      `${name}.js`,
      undefined,
      jarMnSourcePath
    );
    if (!jarMnResult.skipped) await completedWrite(join(engineDir, 'browser/base/jar.mn'));

    return {
      subscriptAdded,
      initAdded,
      destroyAdded,
      domInserted,
      jarMnResult,
    };
  } catch (error: unknown) {
    return completeJournalRollback(ctx, journal, error, {
      projectRoot: root,
      operation: 'create-rollback',
      failureMessage: `Wire failed: ${toError(error).message}`,
      subject: `browser wire ${name}`,
    });
  }
}

/** Wire standalone authoring through the same attributed, serialized mutation lifecycle. */
export async function wireSubscript(
  root: string,
  name: string,
  options: WireOptions = {}
): Promise<WireResult> {
  return runFurnaceMutation(
    root,
    'create-rollback',
    (ctx) => wireSubscriptWithin(root, name, options, ctx),
    { dryRun: options.dryRun === true }
  );
}
