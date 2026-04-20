// SPDX-License-Identifier: EUPL-1.2
import { join, relative } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import { toRootRelativePath } from '../utils/paths.js';
import { getProjectPaths } from './config.js';
import { createRollbackJournal, restoreRollbackJournal, snapshotFile } from './furnace-rollback.js';
import type { RegisterResult } from './manifest-register.js';
import { registerBrowserContent } from './manifest-register.js';
import { DEFAULT_DOM_TARGET } from './wire-dom-fragment.js';
import {
  addDestroyToBrowserInit,
  addDomFragment,
  addInitToBrowserInit,
  addSubscriptToBrowserMain,
} from './wire-targets.js';

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
  /** Dry run — don't write any files */
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
export async function wireSubscript(
  root: string,
  name: string,
  options: WireOptions = {}
): Promise<WireResult> {
  const { engine: engineDir } = getProjectPaths(root);
  const subscriptDir = toRootRelativePath(
    engineDir,
    options.subscriptDir ?? DEFAULT_BROWSER_SUBSCRIPT_DIR
  );

  // Compute jar.mn source path relative to browser/base/
  let jarMnSourcePath: string | undefined;
  if (subscriptDir !== DEFAULT_BROWSER_SUBSCRIPT_DIR) {
    const relPath = relative(
      join(engineDir, BROWSER_BASE_DIR),
      join(engineDir, subscriptDir)
    ).replace(/\\/g, '/');
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

  // Snapshot every file the five mutation steps might touch so a mid-sequence
  // failure (most commonly the chrome-document insertion not finding an
  // anchor) does not leave a half-wired browser behind. Before the rollback
  // journal landed here, a failed `wire` would still have written new
  // `loadSubScript` calls into browser-main.js, new init/destroy expressions
  // into browser-init.js, and a new entry into browser/base/jar.mn — the
  // operator then had to grep the engine tree for the partial mutation and
  // hand-revert, or re-download. The snapshots cover the targets on every
  // code path (init/destroy/DOM are conditional, so we snapshot only when
  // the corresponding option would fire a write) plus the two files every
  // wire touches.
  const journal = createRollbackJournal();
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

  try {
    // 1. Add subscript to browser-main.js
    const subscriptAdded = await addSubscriptToBrowserMain(engineDir, name);

    // 2. Add init expression to browser-init.js (if provided)
    let initAdded = false;
    if (options.init) {
      initAdded = await addInitToBrowserInit(engineDir, options.init, options.after);
    }

    // 3. Add destroy expression to browser-init.js onUnload() (if provided)
    let destroyAdded = false;
    if (options.destroy) {
      destroyAdded = await addDestroyToBrowserInit(engineDir, options.destroy);
    }

    // 4. Add #include directive to the top-level chrome document (if provided)
    let domInserted = false;
    if (options.domFilePath) {
      domInserted = await addDomFragment(
        engineDir,
        toRootRelativePath(engineDir, options.domFilePath),
        options.domTargetPath
      );
    }

    // 5. Register in jar.mn
    const jarMnResult = await registerBrowserContent(
      engineDir,
      `${name}.js`,
      undefined,
      jarMnSourcePath
    );

    return {
      subscriptAdded,
      initAdded,
      destroyAdded,
      domInserted,
      jarMnResult,
    };
  } catch (error: unknown) {
    // Best-effort rollback: if the restore itself fails, surface both the
    // original wire failure and the rollback failure so the operator knows
    // the engine may be in a partially-wired state that needs manual
    // attention. The original error's message is preserved so the user sees
    // *why* the wire failed (e.g. "Could not find insertion point in chrome
    // document") alongside any rollback diagnosis.
    const originalMessage = toError(error).message;
    try {
      await restoreRollbackJournal(journal);
    } catch (rollbackError: unknown) {
      throw new GeneralError(
        `Wire failed: ${originalMessage}. Automatic rollback also failed: ${toError(rollbackError).message}. The engine may contain partially-applied wire mutations; review "git status" under engine/ and revert manually.`
      );
    }
    throw error;
  }
}
