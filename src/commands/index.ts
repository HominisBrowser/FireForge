// SPDX-License-Identifier: EUPL-1.2
/**
 * Every top-level command, in the order the root help lists them. A command
 * lives in its own file here, declares itself with `defineCommand`, and calls
 * one feature function.
 */
import type { Command } from '../cli/command.js';
import type { ProgramSpec } from '../cli/program.js';
import { cliVersion, issuesUrl } from '../cli/version.js';
import { bootstrap } from './bootstrap.js';
import { build } from './build.js';
import { check } from './check.js';
import { config } from './config.js';
import { discard } from './discard.js';
import { doctor } from './doctor.js';
import { download } from './download.js';
import { exportCommand } from './export.js';
import { furnace } from './furnace.js';
import { gate } from './gate.js';
import { importCommand } from './import.js';
import { lint } from './lint.js';
import { mergeDriver } from './merge-driver.js';
import { migrate } from './migrate.js';
import { override } from './override.js';
import { packageCommand } from './package.js';
import { patch } from './patch.js';
import { reExport } from './re-export.js';
import { rebase } from './rebase.js';
import { register } from './register.js';
import { reset } from './reset.js';
import { resolve } from './resolve.js';
import { restore } from './restore.js';
import { run } from './run.js';
import { setup } from './setup.js';
import { status } from './status.js';
import { test } from './test.js';
import { token } from './token.js';
import { typecheck } from './typecheck.js';
import { verify } from './verify.js';
import { version } from './version.js';
import { watch } from './watch.js';
import { wire } from './wire.js';
import { workspace } from './workspace.js';

export const commands: readonly Command[] = [
  // Project
  setup,
  config,
  rebase,
  migrate,
  doctor,
  // Engine
  download,
  bootstrap,
  workspace,
  // Daily
  status,
  lint,
  typecheck,
  verify,
  check,
  build,
  run,
  test,
  gate,
  watch,
  packageCommand,
  exportCommand,
  // Patches
  importCommand,
  resolve,
  reExport,
  patch,
  discard,
  reset,
  // Source
  override,
  restore,
  mergeDriver,
  // Authoring
  register,
  wire,
  token,
  // Components
  furnace,
  version,
];

/** The `fireforge` program. */
export const program: ProgramSpec = {
  name: 'fireforge',
  description: 'Maintain a Firefox fork: source, patches, quality rules, builds and tests',
  version: cliVersion,
  commands,
  issuesUrl,
};
