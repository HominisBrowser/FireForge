// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch <verb>` parent command. Groups single-patch
 * mutations (`compact`, `delete`, `lint-ignore`, `reorder`, `tier`) so
 * they do not clutter the top-level command list. Queue-level verbs
 * like `lint`, `export`, `verify`, and `status` stay flat.
 */

import { Command } from 'commander';

import type { CommandContext } from '../../types/cli.js';
import { registerPatchCompact } from './compact.js';
import { registerPatchDelete } from './delete.js';
import { registerPatchLintIgnore } from './lint-ignore.js';
import { registerPatchReorder } from './reorder.js';
import { registerPatchTier } from './tier.js';

export { patchCompactCommand } from './compact.js';
export { patchDeleteCommand } from './delete.js';
export { patchLintIgnoreCommand } from './lint-ignore.js';
export { patchReorderCommand } from './reorder.js';
export { patchTierCommand } from './tier.js';

/**
 * Registers the `patch` subcommand parent and its verbs on the CLI.
 *
 * @param program - Commander root program
 * @param context - Shared CLI registration context
 */
export function registerPatch(program: Command, context: CommandContext): void {
  const patch = program
    .command('patch')
    .description(
      'Manage individual patches in the queue (compact, delete, lint-ignore, reorder, tier)'
    )
    // Match `fireforge furnace`'s no-args contract: print the group's help and
    // exit 0. Without this default action, commander routes `fireforge patch`
    // (no subcommand) through its own help-then-exit-1 path, so scripts that
    // probe the CLI surface see a misleading non-zero exit for a purely
    // informational invocation. The action prints the exact same help commander
    // would otherwise print, but returns successfully.
    .action(() => {
      patch.outputHelp();
    });

  registerPatchCompact(patch, context);
  registerPatchDelete(patch, context);
  registerPatchLintIgnore(patch, context);
  registerPatchReorder(patch, context);
  registerPatchTier(patch, context);
}
