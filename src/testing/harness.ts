// SPDX-License-Identifier: EUPL-1.2
/**
 * A built workspace with browser-chrome and xpcshell tests, and scripts that
 * make the stand-in `mach` play a test harness: the output a real suite
 * prints and the raw log it writes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { build, type Workspace } from '../engine/index.js';
import { makeEngineProject, makeProjectEngine } from './engine.js';
import type { MachScript } from './firefox.js';
import type { FileTree } from './temp.js';

/** Paths of the tests in {@link makeTestWorkspace}. */
export const TEST_PATHS = {
  browserDir: 'browser/base/content/test/fork',
  browserA: 'browser/base/content/test/fork/browser_a.js',
  browserB: 'browser/base/content/test/fork/browser_b.js',
  browserSupport: 'browser/base/content/test/fork/head.js',
  xpcshellDir: 'browser/modules/test/unit',
  xpcshellX: 'browser/modules/test/unit/test_x.js',
  xpcshellY: 'browser/modules/test/unit/test_y.js',
} as const;

/**
 * The engine files of the tests in {@link TEST_PATHS}, with a mochitest
 * harness that moves busy server ports by itself, and the stand-in recording
 * the harness markers in its log.
 */
export const TEST_ENGINE_FILES: FileTree = {
  [`${TEST_PATHS.browserDir}/browser.toml`]:
    '[DEFAULT]\nsupport-files = ["head.js"]\n\n["browser_a.js"]\n\n["browser_b.js"]\n',
  [TEST_PATHS.browserA]: '',
  [TEST_PATHS.browserB]: '',
  [TEST_PATHS.browserSupport]: '',
  [`${TEST_PATHS.xpcshellDir}/xpcshell.toml`]: '["test_x.js"]\n["test_y.js"]\n',
  [TEST_PATHS.xpcshellX]: '',
  [TEST_PATHS.xpcshellY]: '',
  'testing/mochitest/runtests.py':
    'log.info("%s port %d already in use, falling back to port %d")\n("httpPort", 8888)\nself._port_in_use(port)\n',
  '.mach-state/record-env':
    'FIREFORGE_TEST_RUN FIREFORGE_TEST_ENGINE XPCSHELL_TEST_PROFILE_DIR SUITE_SETTING\n',
};

/**
 * A patch-mode project whose engine has two browser-chrome and two xpcshell
 * tests, built once. The engine's mochitest harness moves busy server ports
 * by itself and the project allows it, so no listener on the host can
 * refuse a run. The stand-in records the harness markers in its log.
 *
 * @param directory - The test's temporary directory
 * @param config - Keys merged into `fireforge.json`
 */
export async function makeTestWorkspace(
  directory: string,
  config: Readonly<Record<string, unknown>> = {}
): Promise<Workspace> {
  const project = await makeEngineProject(directory, {
    config: { test: { mochitestPorts: 'auto' }, ...config },
  });
  const workspace = await makeProjectEngine(project, TEST_ENGINE_FILES);
  await build(workspace);
  return workspace;
}

/**
 * Writes a diff that replaces the stand-in's script for `command` with
 * `script`: a mutation of the behaviour the harness shows, for a negative
 * control. It applies to the script as it is now.
 *
 * @param engineDir - The synthetic engine
 * @param command - The mach command, such as `mochitest`
 * @param script - The script with the mutation
 * @param diffPath - Where the diff goes
 */
export async function writeScriptMutation(
  engineDir: string,
  command: string,
  script: MachScript,
  diffPath: string
): Promise<void> {
  const path = `.mach-state/script-${command}.json`;
  const before = await readFile(join(engineDir, path), 'utf8');
  await writeFile(
    diffPath,
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1 +1 @@',
      `-${before}`,
      '\\ No newline at end of file',
      `+${JSON.stringify(script)}`,
      '\\ No newline at end of file',
      '',
    ].join('\n')
  );
}

const record = (action: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  action,
  ...extra,
});

/**
 * What a harness prints and logs for a suite of `files`: each passes unless
 * `reds` names the assertion it fails at.
 *
 * @param files - Engine-relative test files, in run order
 * @param reds - Failing assertion by file
 * @param suite - The harness, for the suite name
 */
export function harnessScript(
  files: readonly string[],
  reds: Readonly<Record<string, string>> = {},
  suite: 'mochitest-browser' | 'xpcshell' = 'mochitest-browser'
): MachScript {
  const failed = files.filter((file) => reds[file] !== undefined);
  return {
    stdout: [
      ` 0:00.24 SUITE_START: ${suite} - running ${files.length} tests`,
      ...files.flatMap((file) => [
        ` 0:01.00 TEST_START: ${file}`,
        ...(reds[file] === undefined
          ? []
          : [` 0:01.50 TEST-UNEXPECTED-FAIL | ${file} | ${reds[file]}`]),
        ` 0:02.00 TEST_END: ${reds[file] === undefined ? 'Test PASS' : 'Test FAIL'}`,
      ]),
      ' 0:03.00 SUITE_END',
      `Ran ${files.length * 3} checks (${files.length * 3} subtests, 0 tests)`,
      `Unexpected results: ${failed.length}`,
      failed.length === 0 ? 'OK' : 'FAILED',
    ],
    exit: failed.length === 0 ? 0 : 1,
    rawLog: [
      record('suite_start', { tests: { default: files } }),
      ...files.flatMap((file) => [
        record('test_start', { test: file, time: 1000 }),
        ...(reds[file] === undefined
          ? []
          : [
              record('test_status', {
                test: file,
                subtest: reds[file],
                status: 'FAIL',
                expected: 'PASS',
              }),
            ]),
        record('test_end', { test: file, status: 'OK', time: 1400 }),
      ]),
      record('suite_end'),
    ],
  };
}
