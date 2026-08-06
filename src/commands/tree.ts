// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge tree` — copy-on-write verification clones (FORGE G15).
 *
 * Trees enable concurrent READ-MOSTLY verification (lint, typecheck,
 * status, verify, doctor, export dry-runs) beside a busy primary tree.
 * Exports and every other mutation stay strictly serial in the primary —
 * a tree's patches/components are snapshots with no merge model, and the
 * tree guard (cli.ts preAction + core/tree-guard.ts) refuses mutating
 * commands inside a tree. In-tree `test` and objdir cloning are deferred:
 * mach objdirs embed absolute source paths, so a cloned objdir would
 * silently operate against the primary tree.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { Command } from 'commander';

import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { detectCowSupport } from '../core/tree-cow.js';
import { cloneTree, listTrees, removeTree } from '../core/tree-store.js';
import {
  assertValidTreeName,
  computePrimaryFingerprint,
  getTreesDir,
  readTreeMarker,
  withTreeLifecycleLock,
} from '../core/tree-store.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { pathExists } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

function assertPosix(): void {
  if (process.platform === 'win32') {
    throw new GeneralError(
      'fireforge tree is POSIX-only; copy-on-write cloning relies on clonefile/reflink, which are not available on Windows.'
    );
  }
}

/** Creates a verification tree under `.fireforge/trees/<name>`. */
export async function treeCreateCommand(
  projectRoot: string,
  name: string,
  options: { forceCopy?: boolean } = {}
): Promise<void> {
  assertPosix();
  intro('FireForge Tree Create');
  assertValidTreeName(name);
  if (await readTreeMarker(projectRoot)) {
    throw new GeneralError(
      'Verification trees cannot be nested: run tree create in the primary tree.'
    );
  }

  const treesDir = getTreesDir(projectRoot);
  const treeRoot = join(treesDir, name);
  await withTreeLifecycleLock(projectRoot, async () => {
    if (await pathExists(treeRoot)) {
      throw new GeneralError(
        `A tree named "${name}" already exists. Remove it first (fireforge tree remove ${name}) — refresh is remove + create.`
      );
    }
    const { mkdir } = await import('node:fs/promises');
    await mkdir(treesDir, { recursive: true });

    const capability = await detectCowSupport(treesDir);
    if (capability === 'none' && options.forceCopy !== true) {
      throw new GeneralError(
        'This filesystem cannot copy-on-write (APFS clonefile or btrfs/XFS reflink required), so a tree ' +
          'would be a full physical copy of the applied engine tree — potentially tens of gigabytes. ' +
          'Re-run with --force-copy to accept that explicitly.'
      );
    }
    if (capability === 'none') {
      warn('No copy-on-write support detected — performing a full physical copy (--force-copy).');
    }

    // Snapshot under the PRIMARY engine-session lock so a mid-mutation
    // state (half-applied export, furnace deploy) is never captured.
    const marker = await withEngineSessionLock(projectRoot, 'tree create', () =>
      cloneTree({
        primaryRoot: projectRoot,
        treeRoot,
        name,
        capability,
        createdAt: new Date().toISOString(),
      })
    );

    success(`Created verification tree "${name}" at ${treeRoot}`);
    info(`  Engine HEAD: ${marker.engineHead ?? '(no engine)'}`);
    info(
      '  Read-only: status, lint, typecheck, verify, doctor, and export --dry-run run inside it; mutation commands are refused.'
    );
  });
  outro('Tree created');
}

/** Prints the tree list with staleness against the current primary state. */
export async function treeListCommand(
  projectRoot: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const trees = await listTrees(projectRoot);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, trees }, null, 2)}\n`);
    return;
  }
  intro('FireForge Trees');
  if (trees.length === 0) {
    info('No verification trees. Create one with: fireforge tree create <name>');
    outro('Done');
    return;
  }
  for (const tree of trees) {
    info(`${tree.name.padEnd(20)} ${tree.staleness.padEnd(24)} created ${tree.createdAt}`);
  }
  outro(`${trees.length} tree(s)`);
}

/** Removes one tree (or all of them with `--all`). */
export async function treeRemoveCommand(
  projectRoot: string,
  name: string | undefined,
  options: { all?: boolean } = {}
): Promise<void> {
  assertPosix();
  intro('FireForge Tree Remove');
  if (options.all !== true && name === undefined) {
    throw new GeneralError('Pass a tree name, or --all to remove every tree.');
  }
  await withTreeLifecycleLock(projectRoot, async () => {
    const targets =
      options.all === true ? (await listTrees(projectRoot)).map((t) => t.name) : [name ?? ''];
    if (targets.length === 0) {
      info('No verification trees to remove.');
      return;
    }
    for (const target of targets) {
      await removeTree(projectRoot, target);
      success(`Removed verification tree "${target}"`);
    }
  });
  outro('Tree removal complete');
}

/** Spawns `fireforge <args>` with the tree as its working directory. */
async function treeExecCommand(projectRoot: string, name: string, args: string[]): Promise<void> {
  assertPosix();
  assertValidTreeName(name);
  const treeRoot = join(getTreesDir(projectRoot), name);
  const marker = await readTreeMarker(treeRoot);
  if (!marker) {
    throw new GeneralError(
      `No verification tree named "${name}". List trees with: fireforge tree list`
    );
  }
  const current = await computePrimaryFingerprint(projectRoot);
  if (marker.engineHead !== current.engineHead) {
    warn(`Tree "${name}" is stale (primary engine advanced since the snapshot).`);
  } else if (marker.patchesFingerprint !== current.patchesFingerprint) {
    warn(`Tree "${name}" is stale (primary patches changed since the snapshot).`);
  }

  const cliEntry = process.argv[1];
  if (cliEntry === undefined) {
    throw new GeneralError('Cannot resolve the fireforge CLI entry point for tree exec.');
  }
  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: treeRoot,
      stdio: 'inherit',
    });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      resolvePromise(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new GeneralError(
      `tree exec: fireforge ${args.join(' ')} exited with code ${String(exitCode)}.`
    );
  }
}

/** Registers the tree command group on the CLI program. */
export function registerTree(program: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const tree = program
    .command('tree')
    .description(
      'Manage copy-on-write verification clones of this project for concurrent read-mostly work (lint, typecheck, status, verify, export --dry-run). Mutation commands are refused inside a tree.'
    );

  tree
    .command('create <name>')
    .description(
      'Clone the project (engine included, obj-* excluded) into .fireforge/trees/<name> using filesystem copy-on-write (APFS clonefile / btrfs-XFS reflink). Refuses on filesystems without CoW support unless --force-copy explicitly accepts a full physical copy.'
    )
    .option(
      '--force-copy',
      'Allow a full physical copy when the filesystem cannot copy-on-write. This can copy tens of GB; never implied.'
    )
    .action(
      withErrorHandling(async (name: string, options: { forceCopy?: boolean }) => {
        await treeCreateCommand(getProjectRoot(), name, options);
      })
    );

  tree
    .command('list')
    .description(
      'List verification trees with creation time and staleness vs the primary tree (engine HEAD and patches.json fingerprint).'
    )
    .option('--json', 'Output the tree list as JSON')
    .action(
      withErrorHandling(async (options: { json?: boolean }) => {
        await treeListCommand(getProjectRoot(), options);
      })
    );

  tree
    .command('remove [name]')
    .description(
      "Delete a verification tree. Refuses while a live process holds the tree's build or engine-session lock."
    )
    .option('--all', 'Remove every verification tree')
    .action(
      withErrorHandling(async (name: string | undefined, options: { all?: boolean }) => {
        await treeRemoveCommand(getProjectRoot(), name, options);
      })
    );

  tree
    .command('exec <name> [args...]')
    .description(
      'Run a fireforge command inside the named tree (equivalent to cd-ing into it). Example: fireforge tree exec shard-a -- lint --per-patch'
    )
    .action(
      withErrorHandling(async (name: string, args: string[]) => {
        await treeExecCommand(getProjectRoot(), name, args);
      })
    );
}
