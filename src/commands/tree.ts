// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge tree` — copy-on-write verification clones.
 *
 * Trees enable concurrent READ-MOSTLY verification (lint, typecheck,
 * status, verify, doctor, export dry-runs) beside a busy primary tree.
 * Exports and every other mutation stay strictly serial in the primary —
 * a tree's patches/components are snapshots with no merge model, and the
 * tree guard (cli.ts preAction + core/tree-guard.ts) refuses mutating
 * commands inside a tree. `create --with-objdir` additionally clones the
 * primary's built obj-* directory, rewrites its mozinfo.json to the
 * tree, and runs `mach configure` inside the tree so the remaining
 * configure output (config.status, backend.mk, Makefile,
 * config/autoconf.mk — the verified set) stops naming the primary
 * (fail-closed — mach objdirs embed absolute source paths, and an
 * unrelocated clone would silently operate against the primary), which
 * is what admits build-less `fireforge test` inside that tree.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { Command } from 'commander';

import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { hasBuildArtifacts, runMach, withBuildLock } from '../core/mach.js';
import {
  assertBuildArtifacts,
  findObjdirRelocationViolation,
} from '../core/mach-build-artifacts.js';
import { detectCowSupport } from '../core/tree-cow.js';
import { cloneTree, listTrees, removeTree } from '../core/tree-store.js';
import {
  assertValidTreeName,
  computePrimaryFingerprint,
  getTreeMarkerPath,
  getTreesDir,
  readTreeMarkerState,
  withTreeLifecycleLock,
} from '../core/tree-store.js';
import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import { pathExists } from '../utils/fs.js';
import {
  info,
  intro,
  outro,
  setMachineOutputMode,
  setStdoutSealed,
  success,
  warn,
} from '../utils/logger.js';
import { addWaitLockOption, resolveWaitLockSeconds } from '../utils/options.js';

function assertPosix(): void {
  if (process.platform === 'win32') {
    throw new GeneralError(
      'fireforge tree is POSIX-only; copy-on-write cloning relies on clonefile/reflink, which are not available on Windows.'
    );
  }
}

/**
 * Resolves the primary objdir a `--with-objdir` clone will keep,
 * refusing missing, incomplete, ambiguous, or already-mismatched builds
 * before any copying starts.
 */
async function resolveObjdirForClone(projectRoot: string): Promise<string> {
  const engineDir = join(projectRoot, 'engine');
  const buildCheck = await hasBuildArtifacts(engineDir);
  assertBuildArtifacts(engineDir, buildCheck, {
    label: 'tree create --with-objdir',
    requirement: 'tree create --with-objdir requires a completed primary build.',
    remediation: 'Run "fireforge build" first, or create the tree without --with-objdir.',
    requireExisting: true,
  });
  if (buildCheck.objDir === undefined) {
    throw new GeneralError(
      'tree create --with-objdir could not determine the primary obj-* directory.'
    );
  }
  return buildCheck.objDir;
}

/**
 * Runs `mach configure` inside the tree's engine so the configure-generated
 * root files (config.status, backend.mk, Makefile, config/autoconf.mk) are
 * regenerated against the tree's paths — the mozinfo rewrite alone leaves
 * those naming the primary, and a build-less in-tree `test` must never
 * consult primary state. Exit code 0 is not trusted on its own: configure
 * obeys MOZCONFIG / MOZ_OBJDIR, so the postcondition is verified afterwards
 * via `findObjdirRelocationViolation` — the intended objdir was configured,
 * its mozinfo points into the tree, and none of those root files still
 * names the primary engine (nested Makefiles are products of the verified
 * config.status; `.deps` build products are out of scope — see the
 * checker's doc). A failure throws before `cloneTree` writes the marker,
 * so the tree is removed and `clonedObjdir` is never recorded (fail-closed).
 */
async function reconfigureClonedObjdir(
  treeEngineDir: string,
  objDir: string,
  primaryEngineDir: string
): Promise<void> {
  info('  Running mach configure in the tree so no build metadata retains primary paths...');
  let exitCode: number;
  try {
    exitCode = await runMach(['configure'], treeEngineDir);
  } catch (error: unknown) {
    throw new BuildError(
      'mach configure failed in the cloned tree; the tree was removed. ' +
        'Re-run tree create, or create the tree without --with-objdir.',
      'mach configure',
      error instanceof Error ? error : undefined
    );
  }
  if (exitCode !== 0) {
    throw new BuildError(
      `mach configure exited non-zero (${exitCode}) in the cloned tree; the tree was removed. ` +
        'Re-run tree create, or create the tree without --with-objdir.',
      'mach configure'
    );
  }
  const violation = await findObjdirRelocationViolation({
    engineDir: treeEngineDir,
    objDir,
    forbiddenDir: primaryEngineDir,
  });
  if (violation !== undefined) {
    throw new BuildError(
      `mach configure exited 0 in the cloned tree but did not relocate the objdir: ${violation}. ` +
        'The tree was removed. Re-run tree create, or create the tree without --with-objdir.',
      'mach configure'
    );
  }
}

/** Creates a verification tree under `.fireforge/trees/<name>`. */
export async function treeCreateCommand(
  projectRoot: string,
  name: string,
  options: { forceCopy?: boolean; withObjdir?: boolean; waitLockSeconds?: number | undefined } = {}
): Promise<void> {
  assertPosix();
  intro('FireForge Tree Create');
  assertValidTreeName(name);
  // A marker we cannot parse still means "something claims this is a tree", so
  // it must block nesting too — otherwise a corrupt marker is a licence to
  // clone a snapshot into itself.
  const markerState = await readTreeMarkerState(projectRoot);
  if (markerState.kind !== 'absent') {
    throw new GeneralError(
      markerState.kind === 'valid'
        ? 'Verification trees cannot be nested: run tree create in the primary tree.'
        : `${getTreeMarkerPath(projectRoot)} claims this directory is a verification tree, but ` +
            `${markerState.reason}. Repair or delete the marker before creating a tree here.`
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

    // Courtesy fast-fail: refuse obvious no-build cases before waiting on
    // locks. The result is DISCARDED — a build can still start before the
    // locks below are held, so only the re-resolution under the build lock
    // is authoritative for what actually gets cloned.
    if (options.withObjdir === true) {
      await resolveObjdirForClone(projectRoot);
    }

    // Snapshot under the PRIMARY engine-session lock so a mid-mutation
    // state (half-applied export, furnace deploy) is never captured; an
    // objdir snapshot additionally holds the primary BUILD lock, under
    // which the objdir is re-validated immediately before cloning so a
    // concurrent `fireforge build` can neither tear the obj-* mid-write
    // nor swap it after preflight. A failed clone (including the
    // fail-closed mozinfo-rewrite refusal and a failed in-tree
    // reconfigure) removes the partial tree so the name is immediately
    // reusable.
    const marker = await withEngineSessionLock(
      projectRoot,
      'tree create',
      async () => {
        const clone = (objDir?: string): ReturnType<typeof cloneTree> =>
          cloneTree({
            primaryRoot: projectRoot,
            treeRoot,
            name,
            capability,
            createdAt: new Date().toISOString(),
            ...(objDir === undefined
              ? {}
              : {
                  withObjdir: {
                    objDir,
                    reconfigure: (treeEngineDir: string) =>
                      reconfigureClonedObjdir(treeEngineDir, objDir, join(projectRoot, 'engine')),
                  },
                }),
          });
        try {
          return options.withObjdir === true
            ? await withBuildLock(projectRoot, async () =>
                clone(await resolveObjdirForClone(projectRoot))
              )
            : await clone();
        } catch (error: unknown) {
          const { rm } = await import('node:fs/promises');
          await rm(treeRoot, { recursive: true, force: true });
          throw error;
        }
      },
      { waitLockSeconds: options.waitLockSeconds }
    );

    success(`Created verification tree "${name}" at ${treeRoot}`);
    info(`  Engine HEAD: ${marker.engineHead ?? '(no engine)'}`);
    info(
      '  Read-only: status, lint, typecheck, verify, doctor, and export/re-export --dry-run run inside it; mutation commands are refused.'
    );
    if (marker.clonedObjdir !== undefined) {
      info(
        `  Build cloned: ${marker.clonedObjdir} was kept and rewritten to this tree — build-less "fireforge test" runs inside it.`
      );
      info(
        '  Browser tests share Marionette port 2828 with the primary; pass --marionette-port for concurrent runs.'
      );
    }
  });
  outro('Tree created');
}

/** Prints the tree list with staleness against the current primary state. */
export async function treeListCommand(
  projectRoot: string,
  options: { json?: boolean } = {}
): Promise<void> {
  if (options.json === true) {
    // stdout belongs exclusively to the JSON payload: engage machine mode so
    // any diagnostic — including a listTrees failure rendered later by
    // withErrorHandling, which also resets the mode — routes to stderr.
    setMachineOutputMode(true);
    const trees = await listTrees(projectRoot);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, trees }, null, 2)}\n`);
    setMachineOutputMode(false);
    return;
  }
  const trees = await listTrees(projectRoot);
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
  options: { all?: boolean; force?: boolean } = {}
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
      await removeTree(projectRoot, target, { force: options.force === true });
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
  const state = await readTreeMarkerState(treeRoot);
  if (state.kind === 'corrupt') {
    // Collapsing corrupt into "no such tree" misdiagnoses: the directory IS
    // there, claiming to be a tree, and "no tree named X" points the operator
    // at the wrong remediation.
    throw new GeneralError(
      `Tree "${name}" exists but its marker could not be read: ${state.reason}. ` +
        'Recreate it (fireforge tree remove <name> && fireforge tree create <name>).'
    );
  }
  if (state.kind === 'absent') {
    throw new GeneralError(
      `No verification tree named "${name}". List trees with: fireforge tree list`
    );
  }
  const marker = state.marker;
  const current = await computePrimaryFingerprint(projectRoot);
  if (marker.engineHead !== current.engineHead) {
    warn(`Tree "${name}" is stale (primary engine advanced since the snapshot).`);
  } else if (
    marker.engineFingerprint !== undefined &&
    marker.engineFingerprint !== current.engineFingerprint
  ) {
    warn(`Tree "${name}" is stale (primary engine worktree changed since the snapshot).`);
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
  }).finally(() => {
    // With `stdio: 'inherit'` the child owned stdout — including
    // any FIREFORGE-VERDICT line it emitted as its LAST stdout write. From
    // here on the parent must not write stdout again, or its own refusal
    // text (the GeneralError below rendered by withErrorHandling) would
    // print AFTER the child's verdict and break the "verdict is the run's
    // last stdout line" contract at the tree-exec boundary. Sealing routes
    // the parent's remaining output to stderr; withErrorHandling's finally
    // clears the seal.
    setStdoutSealed(true);
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
      'Manage copy-on-write verification clones of this project for concurrent read-mostly work (lint, typecheck, status, verify, export/re-export --dry-run; build-less test with create --with-objdir). Mutation commands are refused inside a tree.'
    );

  addWaitLockOption(
    tree
      .command('create <name>')
      .description(
        'Clone the project (engine included, obj-* excluded) into .fireforge/trees/<name> using filesystem copy-on-write (APFS clonefile / btrfs-XFS reflink). Refuses on filesystems without CoW support unless --force-copy explicitly accepts a full physical copy.'
      )
      .option(
        '--force-copy',
        'Allow a full physical copy when the filesystem cannot copy-on-write. This can copy tens of GB; never implied.'
      )
      .option(
        '--with-objdir',
        'Also clone the primary obj-* build and rewrite its mozinfo.json to the tree (fail-closed), enabling build-less "fireforge test" inside the tree. Requires a completed, unambiguous primary build.'
      )
  ).action(
    withErrorHandling(
      async (
        name: string,
        options: { forceCopy?: boolean; withObjdir?: boolean; waitLock?: number | boolean }
      ) => {
        // The flag is a CLI-layer concern: the command takes the resolved
        // wait budget, matching how furnace routes its subcommand locks.
        const { waitLock, ...rest } = options;
        await treeCreateCommand(getProjectRoot(), name, {
          ...rest,
          waitLockSeconds: resolveWaitLockSeconds(waitLock),
        });
      }
    )
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
      "Delete a verification tree. Refuses while a live process holds the tree's build or engine-session lock, and when a lock exists whose owning process cannot be identified."
    )
    .option('--all', 'Remove every verification tree')
    .option(
      '--force',
      "Delete even when a lock directory's owner cannot be identified. Only safe once you have confirmed no build or test is running against the tree."
    )
    .action(
      withErrorHandling(
        async (name: string | undefined, options: { all?: boolean; force?: boolean }) => {
          await treeRemoveCommand(getProjectRoot(), name, options);
        }
      )
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
