// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch <verb>` parent command. Groups single-patch
 * mutations (`delete`, `reorder`) so they do not clutter the top-level
 * command list. Queue-level verbs like `lint`, `export`, `verify`, and
 * `status` stay flat.
 */

import { Command } from 'commander';

import type { CommandContext } from '../../types/cli.js';
import { registerPatchCompact } from './compact.js';
import { registerPatchDelete } from './delete.js';
import { registerPatchReorder } from './reorder.js';

export { patchCompactCommand } from './compact.js';
export { patchDeleteCommand } from './delete.js';
export { patchReorderCommand } from './reorder.js';

/**
 * Registers the `patch` subcommand parent and its verbs on the CLI.
 *
 * @param program - Commander root program
 * @param context - Shared CLI registration context
 */
export function registerPatch(program: Command, context: CommandContext): void {
  const patch = program
    .command('patch')
    .description('Manage individual patches in the queue (compact, delete, reorder)');

  registerPatchCompact(patch, context);
  registerPatchDelete(patch, context);
  registerPatchReorder(patch, context);
}
