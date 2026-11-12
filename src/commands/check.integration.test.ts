// SPDX-License-Identifier: EUPL-1.2
/**
 * `check` through the CLI in each mode: a green run, each step going red,
 * step selection, project steps and their environment, and the one
 * workspace a source-mode check takes only when a step needs it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LICENSE } from '../config/index.js';
import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { type HostPaths, hostPaths, licenseHeader } from '../project/index.js';
import { type CliResult, runCli } from '../testing/cli.js';
import {
  makeEngineProject,
  makeSourceProject,
  seedPristine,
  useMachSandbox,
} from '../testing/engine.js';
import { makeFurnaceFixture } from '../testing/furnace.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const HEADER = `${licenseHeader(DEFAULT_LICENSE, 'js')}\n`;
const PANEL = 'browser/base/content/panel.mjs';
const NODE = process.execPath;

const host = (): HostPaths => hostPaths({ FIREFORGE_HOME: join(dir(), 'home') });

const cli = (project: { root: string }, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: project.root, env: { FIREFORGE_HOME: host().root } });

interface Step {
  name: string;
  status: string;
  detail: string;
  skipped: string | null;
  output: string[];
}

const steps = (result: CliResult): Record<string, Step> => {
  const document = JSON.parse(result.stdout) as { steps: Step[] };
  return Object.fromEntries(document.steps.map((step) => [step.name, step]));
};

const verdict = (result: CliResult): string => result.stdout.trimEnd().split('\n').at(-1) ?? '';

/** A patch-mode project whose engine is the downloaded pin. */
async function patchProject(config: Record<string, unknown> = {}): Promise<{ root: string }> {
  await seedPristine(host());
  const project = await makeEngineProject(dir(), { config });
  expect((await cli(project, 'download')).exitCode).toBe(ExitCode.SUCCESS);
  return project;
}

describe('fireforge check in patch mode', () => {
  it('passes a clean project, skipping the steps with nothing to run', async () => {
    const project = await patchProject();
    const human = await cli(project, 'check');
    expect(human.exitCode).toBe(ExitCode.SUCCESS);
    expect(human.stdout).toMatch(/^status +pass/m);
    expect(human.stdout).toMatch(/^typecheck +skipped +no "typecheck" block in fireforge\.json$/m);
    expect(verdict(human)).toBe('FIREFORGE-VERDICT: PASS steps=7 passed=3 skipped=4');

    const document = await cli(project, 'check', '--json');
    expect(JSON.parse(document.stdout)).toMatchObject({ schemaVersion: 1, pass: true, failed: [] });
    expect(steps(document)).toMatchObject({
      status: { status: 'pass' },
      verify: { status: 'pass', detail: 'sound' },
      lint: { status: 'pass' },
      typecheck: { status: 'skipped', skipped: 'unavailable' },
      'furnace-validate': { status: 'skipped', detail: 'no furnace.json' },
      'token-coverage': { status: 'skipped' },
      'token-lint': { status: 'skipped' },
    });
  }, 60_000);

  it('goes red on an unaccounted edit, and selects steps with --only and --skip', async () => {
    const project = await patchProject();
    await writeTree(join(project.root, 'engine'), { [PANEL]: 'export const panel = 1;\n' });

    const red = await cli(project, 'check');
    expect(red.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(red.stdout).toMatch(/^status +fail .*1 unmanaged$/m);
    expect(red.stdout).toContain(`    unmanaged  ${PANEL}: changed, and no patch holds it`);
    expect(verdict(red)).toBe(
      'FIREFORGE-VERDICT: FAIL reason=check-failed failed=status steps=7 passed=2 skipped=4'
    );

    const status = await cli(project, 'check', '--only', 'status', '--json');
    expect(status.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(JSON.parse(status.stdout)).toMatchObject({ pass: false, failed: ['status'] });
    expect(Object.keys(steps(status))).toEqual(['status']);

    const skipped = await cli(project, 'check', '--skip', 'status', '--json');
    expect(skipped.exitCode).toBe(ExitCode.SUCCESS);
    expect(steps(skipped)['status']).toMatchObject({ status: 'skipped', skipped: 'config' });

    const unknown = await cli(project, 'check', '--only', 'nope');
    expect(unknown.exitCode).toBe(ExitCode.INVALID_ARGUMENT);
    expect(unknown.stderr).toContain('"nope" is not a check step');
  }, 60_000);

  it('applies check.status, check.skip and check.failOnSkipped', async () => {
    const project = await patchProject({
      check: { status: { allow: ['unmanaged'] }, skip: ['lint'], failOnSkipped: true },
    });
    await writeTree(join(project.root, 'engine'), { [PANEL]: 'export const panel = 1;\n' });
    const result = await cli(project, 'check', '--json');
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(steps(result)).toMatchObject({
      status: { status: 'pass' },
      lint: { status: 'skipped', detail: 'skipped by check.skip in fireforge.json' },
    });
    // A step the project left out is a decision; one with nothing to run is a gap.
    expect(JSON.parse(result.stdout)).toMatchObject({
      failed: ['typecheck', 'furnace-validate', 'token-coverage', 'token-lint'],
    });
  }, 60_000);

  it('fails verify on a queue that does not hold together', async () => {
    const project = await patchProject();
    await writeTree(project.root, { 'patches/001-ui-lost.patch': 'not a patch\n' });
    const result = await cli(project, 'check', '--only', 'verify', '--json');
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(steps(result)['verify']).toMatchObject({ status: 'fail' });
  }, 60_000);

  it('runs project steps after the steps they name, with the documented environment', async () => {
    const seen = join(dir(), 'seen.json');
    const record = `require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
      root: process.env.FIREFORGE_PROJECT_ROOT, engine: process.env.FIREFORGE_ENGINE,
      owned: require("fs").readFileSync(process.env.FIREFORGE_OWNED_PATHS, "utf8"),
      report: require(process.env.FIREFORGE_CHECK_LINT_REPORT).findings.length, cwd: process.cwd() }))`;
    const project = await patchProject({
      check: {
        lintReport: '.fireforge/lint-report.json',
        extraSteps: [
          { name: 'record', command: [NODE, '-e', record], after: ['lint'], engine: true },
          { name: 'broken', command: [NODE, '-e', 'console.log("why"); process.exit(3)'] },
          { name: 'slow', command: [NODE, '-e', 'setTimeout(() => {}, 60000)'], timeout: 1 },
        ],
      },
    });
    await writeTree(join(project.root, 'engine'), {
      [PANEL]: `${HEADER}export const panel = 1;\n`,
    });
    const result = await cli(project, 'check', '--skip', 'status', '--json');
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(steps(result)).toMatchObject({
      record: { status: 'pass' },
      broken: { status: 'fail', detail: 'exit 3', output: ['why'] },
      slow: { status: 'fail', detail: 'timed out after 1s' },
    });
    const root = await readFile(seen, 'utf8').then((text) => JSON.parse(text) as unknown);
    expect(root).toMatchObject({
      engine: expect.stringMatching(/engine$/) as unknown,
      owned: `${PANEL}\n`,
      report: 0,
    });
    const only = await cli(project, 'check', '--only', 'record', '--json');
    expect(Object.keys(steps(only))).toEqual(['record']);
  }, 60_000);

  it('fails furnace-validate on a component that breaks the rules', async () => {
    const f = await makeFurnaceFixture(dir(), {
      furnace: {
        version: 1,
        componentPrefix: 'moz-',
        custom: {
          'moz-acme-x': { description: '', targetPath: 'x', register: true, localized: false },
        },
      },
      files: { 'components/custom/moz-acme-x/moz-acme-x.css': ':host { color: #fff; }\n' },
    });
    const result = await runCli(['check', '--only', 'furnace-validate', '--json'], { cwd: f.root });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(steps(result)['furnace-validate']).toMatchObject({ status: 'fail' });
    expect(steps(result)['furnace-validate']?.output.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('fireforge check in source mode', () => {
  it('reads the owned files without a workspace, and leases one when a step needs the engine', async () => {
    const project = await makeSourceProject(dir(), {
      files: { [`src/${PANEL}`]: `${HEADER}export const panel = 1;\n` },
      config: {
        check: {
          extraSteps: [
            {
              name: 'engine-reader',
              command: [
                NODE,
                '-e',
                `if (!require("fs").existsSync(process.env.FIREFORGE_ENGINE + "/${PANEL}")) process.exit(1)`,
              ],
              engine: true,
            },
          ],
        },
      },
    });
    const reads = await cli(project, 'check', '--skip', 'engine-reader');
    expect(reads.stderr).toBe('');
    expect(reads.exitCode).toBe(ExitCode.SUCCESS);
    expect(verdict(reads)).toBe('FIREFORGE-VERDICT: PASS steps=8 passed=3 skipped=5');
    expect(await exists(host().workspaces)).toBe(false);

    const all = await cli(project, 'check', '--json');
    expect(all.exitCode).toBe(ExitCode.SUCCESS);
    expect(steps(all)['engine-reader']).toMatchObject({ status: 'pass' });
    expect(await exists(join(host().workspaces, 'w1', 'engine', PANEL))).toBe(true);

    await writeTree(project.root, {
      'src/browser/base/content/browser.js': 'export const browserTitle = "mine";\n',
      'src/browser/base/content/bare.mjs': 'export const bare = 1;\n',
    });
    const red = await cli(project, 'check', '--skip', 'engine-reader', '--json');
    expect(red.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(JSON.parse(red.stdout)).toMatchObject({ failed: ['status', 'verify', 'lint'] });
    expect(steps(red)['lint']?.output.join('\n')).toContain('missing-license-header');
  }, 60_000);

  it('type-checks the configured projects in the leased workspace', async () => {
    const at = 'browser/base/content/typed';
    const project = await makeSourceProject(dir(), {
      files: {
        [`src/${at}/jsconfig.json`]: JSON.stringify({
          compilerOptions: { checkJs: true, noEmit: true },
          files: ['count.mjs'],
        }),
        [`src/${at}/count.mjs`]: `${HEADER}/** @type {number} */\nexport const count = "one";\n`,
      },
      config: { typecheck: { projects: [`engine/${at}/jsconfig.json`] } },
    });
    const red = await cli(project, 'check', '--only', 'typecheck', '--json');
    expect(red.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(steps(red)['typecheck']).toMatchObject({ status: 'fail' });
    expect(steps(red)['typecheck']?.output.join('\n')).toContain(
      "Type 'string' is not assignable to type 'number'"
    );

    await writeTree(project.root, {
      [`src/${at}/count.mjs`]: `${HEADER}/** @type {number} */\nexport const count = 1;\n`,
    });
    const green = await cli(project, 'check', '--only', 'typecheck', '--json');
    expect(green.exitCode).toBe(ExitCode.SUCCESS);
    expect(steps(green)['typecheck']).toMatchObject({ detail: '0 errors, 0 warnings' });
  }, 120_000);

  it('judges the design tokens once the project has a token file', async () => {
    const themes = 'browser/themes/shared';
    const project = await makeSourceProject(dir(), {
      files: {
        [`src/${themes}/testbrowser-tokens.css`]: `${HEADER}:root {\n  --testbrowser-accent: #123456;\n}\n`,
        [`src/${themes}/panel.css`]: `${HEADER}.panel {\n  color: #ffffff;\n}\n`,
      },
      config: { check: { minTokenCoverage: 50 } },
    });
    const red = await cli(project, 'check', '--only', 'token-coverage', '--json');
    expect(red.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(steps(red)['token-coverage']).toMatchObject({
      status: 'fail',
      detail: 'coverage 0%, below 50%',
    });

    await writeTree(project.root, {
      [`src/${themes}/panel.css`]: `${HEADER}.panel {\n  color: var(--testbrowser-accent);\n}\n`,
    });
    const green = await cli(project, 'check', '--only', 'token-coverage', '--only', 'token-lint');
    expect(green.exitCode).toBe(ExitCode.SUCCESS);
    expect(green.stdout).toMatch(/^token-coverage +pass .*coverage 100%$/m);
    expect(green.stdout).toMatch(/^token-lint +pass .*0 findings in \d+ stylesheets?$/m);
  }, 60_000);
});
