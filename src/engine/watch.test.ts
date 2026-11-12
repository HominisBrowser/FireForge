// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { loadProject } from '../project/index.js';
import { useMachSandbox } from '../testing/engine.js';
import { HOST_PYTHON, readMachLog, scriptMach, writeSyntheticFirefox } from '../testing/firefox.js';
import { initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { findWatchman, watch } from './watch.js';
import { type Workspace, workspaceAt } from './workspace.js';

const run = promisify(execFile);
const dir = useTempDir();
useMachSandbox();

/** A directory holding a `watchman` that answers `--version` as scripted. */
async function fakeWatchman(script: string): Promise<string> {
  const bin = join(dir(), 'watchman-bin');
  await writeTree(bin, { watchman: `#!/bin/sh\n${script}\n` });
  await chmod(join(bin, 'watchman'), 0o755);
  return bin;
}

async function builtWorkspace(): Promise<Workspace> {
  const root = join(dir(), 'project');
  await writeTree(root, {
    'fireforge.json': JSON.stringify({
      name: 'Test Browser',
      vendor: 'Test',
      appId: 'org.example.testbrowser',
      binaryName: 'testbrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    }),
    'configs/common.mozconfig': 'ac_add_options --enable-application=browser\n',
    [`configs/${process.platform}.mozconfig`]: '# platform\n',
  });
  const engineDir = join(root, 'engine');
  await writeSyntheticFirefox(engineDir, {
    '.mach-state/binary-name': 'testbrowser',
    '.mach-state/record-env': 'PATH\n',
  });
  await initRepo(engineDir);
  await run(HOST_PYTHON, ['mach', 'build'], { cwd: engineDir });
  const project = await loadProject(root, { FIREFORGE_HOME: join(dir(), 'home') });
  return workspaceAt(project, {
    name: 'engine',
    kind: 'project',
    engineDir,
    stateDir: project.paths.stateDir,
    stateFile: project.paths.state,
  });
}

describe.skipIf(process.platform === 'win32')('watch', () => {
  it('finds watchman on the given PATH and refuses one that does not answer', async () => {
    const good = await fakeWatchman('echo 2026.01.01.00');
    expect(await findWatchman({ PATH: good })).toBe(join(good, 'watchman'));
    const broken = await fakeWatchman('exit 1');
    await expect(findWatchman({ PATH: broken })).rejects.toMatchObject({
      code: 'watchman-unusable',
      exitCode: ExitCode.MISSING_DEPENDENCY,
    });
  });

  it('runs mach watch with the watchman directory first on PATH', async () => {
    const workspace = await builtWorkspace();
    const bin = await fakeWatchman('echo 2026.01.01.00');
    const base = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
    const env = { PATH: [...base, bin].join(delimiter) };
    await watch(workspace, { env });
    const call = (await readMachLog(workspace.engineDir)).at(-1);
    expect(call?.args).toEqual(['watch']);
    const path = call?.env['PATH']?.split(delimiter) ?? [];
    expect(path[0]).toBe(dirname(await findWatchman(env)));
    expect(path).toContain(bin);
    expect(path.filter((entry) => entry === path[0])).toHaveLength(1);
  });

  it('explains a watch that fails because configure never saw watchman', async () => {
    const workspace = await builtWorkspace();
    const bin = await fakeWatchman('echo 2026.01.01.00');
    await scriptMach(workspace.engineDir, 'watch', {
      stderr: ['watchman was not found at configure time'],
      exit: 1,
    });
    const base = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
    await expect(
      watch(workspace, { env: { PATH: [bin, ...base].join(delimiter) } })
    ).rejects.toMatchObject({
      code: 'mach-failed',
      hint: expect.stringMatching(/configured before watchman/) as unknown,
    });
  });
});
