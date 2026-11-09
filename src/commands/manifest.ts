// SPDX-License-Identifier: EUPL-1.2
/**
 * Central manifest of every top-level FireForge command.
 *
 * The manifest is iterated from {@link createProgram} in cli.ts so that
 * adding a new command is a one-line change here instead of a three-line
 * edit (import + registration call + ordering) spread across cli.ts. It
 * also gives documentation tooling and tests a single authoritative list
 * of commands to enumerate.
 *
 * The order of entries in {@link COMMAND_MANIFEST} is the order commands
 * appear in `fireforge --help`. The order is chosen rather than
 * alphabetical, and groups related commands together.
 */
import type { CommandRegistrar } from '../types/cli.js';
import { registerAuthored } from './authored.js';
import { registerBootstrap } from './bootstrap.js';
import { registerBuild } from './build.js';
import { registerCheck } from './check.js';
import { registerConfig } from './config.js';
import { registerDiscard } from './discard.js';
import { registerDoctor } from './doctor.js';
import { registerDownload } from './download.js';
import { registerExport } from './export.js';
import { registerExportAll } from './export-all.js';
import { registerFurnace } from './furnace/index.js';
import { registerHost } from './host.js';
import { registerImport } from './import.js';
import { registerJob } from './job.js';
import { registerLint } from './lint.js';
import { registerPackage } from './package.js';
import { registerPark } from './park.js';
import { registerPatch } from './patch/index.js';
import { registerProve } from './prove.js';
import { registerReExport } from './re-export-register.js';
import { registerRebase } from './rebase/index.js';
import { registerRegister } from './register.js';
import { registerReset } from './reset.js';
import { registerResolve } from './resolve.js';
import { registerRun } from './run.js';
import { registerSetup } from './setup.js';
import { registerSlot } from './slot.js';
import { registerSource } from './source.js';
import { registerStatus } from './status.js';
import { registerTest } from './test-register.js';
import { registerToken } from './token.js';
import { registerTree } from './tree.js';
import { registerTypecheck } from './typecheck.js';
import { registerVerify } from './verify.js';
import { registerWatch } from './watch.js';
import { registerWire } from './wire.js';

/**
 * A single entry in the command manifest.
 */
export interface CommandManifestEntry {
  /**
   * Human-readable command name, matching the first token of the
   * command line (e.g. `build`, `furnace`). Informational only, since the
   * authoritative command string lives inside each registrar's
   * `.command(...)` call, but useful for documentation, manifest
   * introspection, and test assertions.
   */
  name: string;
  /**
   * Group label used by the root CLI help and generated documentation.
   */
  group: 'project' | 'workflow' | 'engine' | 'diagnostics' | 'components';
  /**
   * True when the command rewrites or edits files in `engine/` and therefore
   * holds the engine-session lock while it does (shared under `--dry-run`).
   * A command that edits through the authoring writer skips the lock in
   * source mode, where `engine/` is not written. The
   * registration test holds a hand-kept classification of every command that
   * must agree with these flags, and drives every flagged command, failing
   * when one does not acquire the lock.
   */
  mutatesEngine?: true;
  /** Registers the command (and any subcommands) on the Commander program. */
  register: CommandRegistrar;
}

/**
 * Ordered list of every top-level FireForge command. cli.ts iterates this
 * array to register commands in a single loop.
 */
export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = [
  { name: 'setup', group: 'project', register: registerSetup },
  { name: 'source', group: 'project', register: registerSource },
  { name: 'authored', group: 'workflow', register: registerAuthored },
  { name: 'host', group: 'workflow', register: registerHost },
  { name: 'slot', group: 'workflow', register: registerSlot },
  { name: 'job', group: 'workflow', register: registerJob },
  { name: 'prove', group: 'workflow', register: registerProve },
  { name: 'download', group: 'engine', mutatesEngine: true, register: registerDownload },
  { name: 'bootstrap', group: 'engine', register: registerBootstrap },
  { name: 'import', group: 'workflow', mutatesEngine: true, register: registerImport },
  { name: 'resolve', group: 'workflow', mutatesEngine: true, register: registerResolve },
  { name: 'build', group: 'workflow', register: registerBuild },
  { name: 'run', group: 'workflow', register: registerRun },
  { name: 'status', group: 'workflow', register: registerStatus },
  { name: 'reset', group: 'workflow', mutatesEngine: true, register: registerReset },
  { name: 'discard', group: 'workflow', mutatesEngine: true, register: registerDiscard },
  { name: 'export', group: 'workflow', mutatesEngine: true, register: registerExport },
  { name: 'export-all', group: 'workflow', mutatesEngine: true, register: registerExportAll },
  { name: 're-export', group: 'workflow', mutatesEngine: true, register: registerReExport },
  { name: 'park', group: 'workflow', mutatesEngine: true, register: registerPark },
  { name: 'patch', group: 'workflow', register: registerPatch },
  { name: 'rebase', group: 'workflow', mutatesEngine: true, register: registerRebase },
  { name: 'package', group: 'workflow', register: registerPackage },
  { name: 'watch', group: 'workflow', register: registerWatch },
  { name: 'test', group: 'workflow', register: registerTest },
  { name: 'tree', group: 'workflow', register: registerTree },
  { name: 'config', group: 'project', register: registerConfig },
  { name: 'doctor', group: 'diagnostics', register: registerDoctor },
  { name: 'register', group: 'workflow', mutatesEngine: true, register: registerRegister },
  { name: 'wire', group: 'workflow', mutatesEngine: true, register: registerWire },
  { name: 'token', group: 'components', mutatesEngine: true, register: registerToken },
  { name: 'lint', group: 'diagnostics', register: registerLint },
  { name: 'typecheck', group: 'diagnostics', register: registerTypecheck },
  { name: 'verify', group: 'diagnostics', register: registerVerify },
  { name: 'check', group: 'diagnostics', register: registerCheck },
  { name: 'furnace', group: 'components', register: registerFurnace },
];
