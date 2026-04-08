// SPDX-License-Identifier: EUPL-1.2
import { join, relative } from 'node:path';

import { toRootRelativePath } from '../utils/paths.js';
import { getProjectPaths } from './config.js';
import type { RegisterResult } from './manifest-register.js';
import { registerBrowserContent } from './manifest-register.js';
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

  // 4. Add #include directive to browser.xhtml (if provided)
  let domInserted = false;
  if (options.domFilePath) {
    domInserted = await addDomFragment(
      engineDir,
      toRootRelativePath(engineDir, options.domFilePath)
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
}
