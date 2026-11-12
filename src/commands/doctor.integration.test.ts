// SPDX-License-Identifier: EUPL-1.2
/** `doctor` through the CLI: a healthy project in each mode, and broken ones with their fixes. */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { type HostPaths, hostPaths } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { TEST_PIN_KEY } from '../testing/config.js';
import {
  makeEngineProject,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { commitAll, git, GIT_PASSES_ANCESTOR_LABEL } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const host = (): HostPaths => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

const cli = (project: { root: string }, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: host().root } });

interface Check {
  id: string;
  status: string;
  detail: string;
  fix: string | null;
}

const checks = (result: CliResult): Record<string, Check> => {
  const document = JSON.parse(result.stdout) as { checks: Check[] };
  return Object.fromEntries(document.checks.map((check) => [check.id, check]));
};

describe('fireforge doctor', () => {
  it('finds a downloaded patch-mode project healthy, and names what a broken one needs', async () => {
    await seedPristine(host());
    const project = await makeEngineProject(dir());

    const before = await cli(project, 'doctor', '--json');
    expect(before.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(checks(before)).toMatchObject({
      config: { status: 'ok' },
      git: { status: 'ok' },
      pristine: { status: 'ok', detail: expect.stringContaining(TEST_PIN_KEY) as unknown },
      engine: { status: 'fail', fix: 'Run "fireforge download".' },
    });
    expect(checks(before)).not.toHaveProperty('storage');

    expect((await cli(project, 'download')).exitCode).toBe(ExitCode.SUCCESS);
    const healthy = await cli(project, 'doctor');
    expect(healthy.exitCode).toBe(ExitCode.SUCCESS);
    expect(healthy.stdout).toMatch(
      /^ok +Engine +engine\/ is a checkout of firefox-esr-140\.9\.0esr$/m
    );
    expect(healthy.stdout).toMatch(/^ok +Patch queue +Sound$/m);
    expect(healthy.stdout).toMatch(/\d+ ok, \d+ warning\(s\), 0 failed\.\n$/);

    // A run killed mid-transaction leaves its journal; doctor says so and undoes it on request.
    const journal = join(project.root, '.fireforge', 'queue.journal');
    await mkdir(join(project.root, '.fireforge'), { recursive: true });
    await writeFile(
      journal,
      `${JSON.stringify({ journal: 1, label: 'the patch queue update', pid: 999_999_99, startedAt: '2026-01-01T00:00:00.000Z' })}\n`
    );
    const interrupted = await cli(project, 'doctor', '--json');
    expect(interrupted.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(checks(interrupted)['journals']).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('the patch queue update') as unknown,
      fix: expect.stringContaining('fireforge doctor --recover') as unknown,
    });
    const recovered = await cli(project, 'doctor', '--recover', '--json');
    expect(recovered.exitCode).toBe(ExitCode.SUCCESS);
    expect(checks(recovered)['journals']).toMatchObject({ detail: 'Undid 1 interrupted run(s)' });
    expect(await exists(journal)).toBe(false);

    await git(join(project.root, 'engine'), ['commit', '--quiet', '--allow-empty', '-m', 'moved']);
    const moved = await cli(project, 'doctor', '--json');
    expect(checks(moved)['engine']).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('fireforge rebase') as unknown,
    });
  }, 60_000);

  it('reports a configuration that does not load and still checks the host', async () => {
    await writeTree(dir(), { 'fireforge.json': '{ "name": 1 }' });
    const result = await cli({ root: dir() }, 'doctor', '--json');
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(checks(result)).toMatchObject({
      config: { status: 'fail' },
      python: { status: 'ok' },
      journals: { status: 'ok' },
      locks: { status: 'ok', detail: 'None held' },
    });
    expect(checks(result)).not.toHaveProperty('pristine');
  });

  it.skipIf(process.platform === 'win32')(
    'probes each declared tool by path, by xcrun and on PATH, failing only for a required one',
    async () => {
      const bin = join(dir(), 'bin');
      await writeTree(bin, {
        xcrun:
          '#!/bin/sh\n[ "$1" = -find ] && [ "$2" = actool ] && echo /sdk/usr/bin/actool && exit 0\nexit 72\n',
        packer: '#!/bin/sh\n',
      });
      await chmod(join(bin, 'xcrun'), 0o755);
      await chmod(join(bin, 'packer'), 0o755);
      vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
      await seedPristine(host());
      const tools = [
        { name: 'packer' },
        { name: 'actool', xcrun: true },
        { name: 'signer', path: 'tools/signer' },
        { name: 'iconutil-absent', xcrun: true, required: false },
        { name: 'no-such-fireforge-tool', required: false },
      ];
      const project = await makeEngineProject(dir(), {
        config: { externalToolchains: [{ name: 'branding', tools }] },
        files: { 'tools/signer': '#!/bin/sh\n' },
      });
      expect((await cli(project, 'download')).exitCode).toBe(ExitCode.SUCCESS);

      const optional = await cli(project, 'doctor', '--json');
      expect(optional.exitCode).toBe(ExitCode.SUCCESS);
      expect(checks(optional)).toMatchObject({
        'toolchain:branding/packer': { status: 'ok', detail: join(bin, 'packer') },
        'toolchain:branding/actool': { status: 'ok', detail: '/sdk/usr/bin/actool' },
        'toolchain:branding/signer': {
          status: 'ok',
          detail: join(project.root, 'tools/signer'),
        },
        'toolchain:branding/iconutil-absent': {
          status: 'warn',
          detail:
            'iconutil-absent, which toolchain "branding" uses, was not found by "xcrun -find iconutil-absent"',
        },
        'toolchain:branding/no-such-fireforge-tool': {
          status: 'warn',
          detail: expect.stringContaining('was not found on PATH') as unknown,
          fix: expect.stringContaining('"branding" entry of externalToolchains') as unknown,
        },
      });

      await writeFile(
        join(project.root, 'fireforge.json'),
        JSON.stringify({
          ...(JSON.parse(await readFile(join(project.root, 'fireforge.json'), 'utf8')) as object),
          externalToolchains: [
            { name: 'release', tools: [{ name: 'notary', path: 'tools/notary' }] },
          ],
        })
      );
      const required = await cli(project, 'doctor');
      expect(required.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(required.stdout).toMatch(
        /^fail +Toolchain release: notary +notary, which toolchain "release" requires, was not found at tools\/notary$/m
      );
      expect(required.stderr).toContain('1 check(s) failed: toolchain:release/notary.');
    },
    60_000
  );

  // A git without the ancestor label is itself a finding, so no project is healthy on it.
  it.skipIf(!GIT_PASSES_ANCESTOR_LABEL)(
    'checks a source-mode project: the pin, the merge driver, the pool and the records',
    async () => {
      const project = await makeSourceProject(dir(), {
        files: { 'src/browser/base/content/panel.mjs': 'export {};\n' },
      });
      const missing = await cli(project, 'doctor', '--json');
      expect(missing.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(checks(missing)).toMatchObject({
        'merge-driver': { status: 'fail', fix: 'Run "fireforge merge-driver install".' },
        workspaces: { status: 'ok', detail: expect.stringContaining('None on') as unknown },
        storage: { status: 'ok' },
      });

      expect((await cli(project, 'merge-driver', 'install')).exitCode).toBe(ExitCode.SUCCESS);
      expect((await cli(project, 'build')).exitCode).toBe(ExitCode.SUCCESS);
      const healthy = await cli(project, 'doctor', '--json');
      expect(healthy.exitCode).toBe(ExitCode.SUCCESS);
      expect(checks(healthy)['workspaces']).toMatchObject({ detail: 'w1 (built, free)' });

      // An upstream file edited without a record is what verify refuses.
      await writeTree(project.root, {
        'src/browser/base/content/browser.js': 'export const browserTitle = "mine";\n',
      });
      await commitAll(project.root, 'undeclared');
      const broken = await cli(project, 'doctor', '--json');
      expect(broken.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(checks(broken)['storage']).toMatchObject({ status: 'fail' });
      expect(broken.stderr).toContain('1 check(s) failed: storage.');
    },
    60_000
  );
});
