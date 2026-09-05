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
 * appear in `fireforge --help`; it is intentional, not alphabetical, and
 * groups related commands together.
 */
import type { CommandRegistrar } from '../types/cli.js';
import { registerBootstrap } from './bootstrap.js';
import { registerBuild } from './build.js';
import { registerConfig } from './config.js';
import { registerDiscard } from './discard.js';
import { registerDoctor } from './doctor.js';
import { registerDownload } from './download.js';
import { registerExport } from './export.js';
import { registerExportAll } from './export-all.js';
import { registerFurnace } from './furnace/index.js';
import { registerImport } from './import.js';
import { registerLint } from './lint.js';
import { registerPackage } from './package.js';
import { registerPatch } from './patch/index.js';
import { registerReExport } from './re-export-register.js';
import { registerRebase } from './rebase/index.js';
import { registerRegister } from './register.js';
import { registerReset } from './reset.js';
import { registerResolve } from './resolve.js';
import { registerRun } from './run.js';
import { registerSetup } from './setup.js';
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
   * command line (e.g. `build`, `furnace`). Informational only — the
   * authoritative command string lives inside each registrar's
   * `.command(...)` call — but useful for documentation, manifest
   * introspection, and test assertions.
   */
  name: string;
  /**
   * Short one-line group label, used purely for grouping in generated
   * documentation. Not surfaced in the CLI itself.
   */
  group: 'project' | 'workflow' | 'engine' | 'diagnostics' | 'components';
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
  { name: 'download', group: 'engine', register: registerDownload },
  { name: 'bootstrap', group: 'engine', register: registerBootstrap },
  { name: 'import', group: 'workflow', register: registerImport },
  { name: 'resolve', group: 'workflow', register: registerResolve },
  { name: 'build', group: 'workflow', register: registerBuild },
  { name: 'run', group: 'workflow', register: registerRun },
  { name: 'status', group: 'workflow', register: registerStatus },
  { name: 'reset', group: 'workflow', register: registerReset },
  { name: 'discard', group: 'workflow', register: registerDiscard },
  { name: 'export', group: 'workflow', register: registerExport },
  { name: 'export-all', group: 'workflow', register: registerExportAll },
  { name: 're-export', group: 'workflow', register: registerReExport },
  { name: 'patch', group: 'workflow', register: registerPatch },
  { name: 'rebase', group: 'workflow', register: registerRebase },
  { name: 'package', group: 'workflow', register: registerPackage },
  { name: 'watch', group: 'workflow', register: registerWatch },
  { name: 'test', group: 'workflow', register: registerTest },
  { name: 'tree', group: 'workflow', register: registerTree },
  { name: 'config', group: 'project', register: registerConfig },
  { name: 'doctor', group: 'diagnostics', register: registerDoctor },
  { name: 'register', group: 'workflow', register: registerRegister },
  { name: 'wire', group: 'workflow', register: registerWire },
  { name: 'token', group: 'components', register: registerToken },
  { name: 'lint', group: 'diagnostics', register: registerLint },
  { name: 'typecheck', group: 'diagnostics', register: registerTypecheck },
  { name: 'verify', group: 'diagnostics', register: registerVerify },
  { name: 'furnace', group: 'components', register: registerFurnace },
];
