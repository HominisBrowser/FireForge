// SPDX-License-Identifier: EUPL-1.2
/**
 * `lint` and `typecheck` through the CLI, in source-mode projects over the
 * seeded pristine repository.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { type CliResult, runCli } from '../testing/cli.js';
import { makeSourceProject, useMachSandbox } from '../testing/engine.js';
import { SYNTHETIC_FIREFOX_PATHS } from '../testing/firefox.js';
import { useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

const HEADER = '/* SPDX-License-Identifier: EUPL-1.2 */\n';
const BROWSER = SYNTHETIC_FIREFOX_PATHS.browserScript;
const SERVICE = SYNTHETIC_FIREFOX_PATHS.serviceModule;

const cli = (root: string, ...args: string[]): Promise<CliResult> =>
  runCli(args, { cwd: root, env: { FIREFORGE_HOME: join(dir(), 'home') } });

describe('fireforge lint', () => {
  it('passes clean owned files and fails on an error with a next step, as text and as JSON', async () => {
    const clean = await makeSourceProject(dir(), {
      config: { license: 'EUPL-1.2' },
      files: { 'src/browser/a.mjs': `${HEADER}export {};\n` },
    });
    const passed = await cli(clean.root, 'lint');
    expect(passed.exitCode).toBe(ExitCode.SUCCESS);
    expect(passed.stdout).toBe('Lint: 0 error(s), 0 warning(s), 0 notice(s)\n');

    const dirty = await makeSourceProject(
      dir(),
      {
        config: { license: 'EUPL-1.2' },
        files: { 'src/browser/a.mjs': `${HEADER}import "./b.mjs";\n` },
      },
      'dirty'
    );
    const failed = await cli(dirty.root, 'lint', '--json');
    expect(failed.exitCode).toBe(ExitCode.GENERAL_ERROR);
    const document = JSON.parse(failed.stdout) as { findings: { rule: string }[] };
    expect(document).toMatchObject({ schemaVersion: 1, pass: false, errors: 1 });
    expect(document.findings.map((finding) => finding.rule)).toContain('relative-import');
    expect(failed.stderr).toContain('Lint failed: ');
    expect(failed.stderr).toContain('lintIgnore');
  }, 60_000);

  it('fails on warnings only past --max-warnings, and narrows to the paths named', async () => {
    const project = await makeSourceProject(dir(), {
      config: {
        license: 'EUPL-1.2',
        patchLint: {
          patchSizeThresholds: { general: { files: { notice: 1, warning: 1, error: 50 } } },
        },
      },
      // Any number of created files is no finding: a group of created files is not sized.
      files: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`src/browser/app/f${i}.js`, HEADER])
      ),
    });
    for (const path of [BROWSER, SERVICE]) {
      const declared = await cli(project.root, 'override', path, '--component', 'ui-title');
      expect(declared.exitCode).toBe(ExitCode.SUCCESS);
      await writeTree(project.root, {
        [`src/${path}`]: `${HEADER}export const changed = 1; // TESTBROWSER: changed\n`,
      });
    }
    const all = await cli(project.root, 'lint', '--json');
    expect(all.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(all.stdout)).toMatchObject({
      warnings: 1,
      findings: [{ rule: 'large-patch-files', group: 'ui-title' }],
    });
    const strict = await cli(project.root, 'lint', '--max-warnings', '0');
    expect(strict.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(strict.stderr).toContain('more than --max-warnings 0');
    const narrowed = await cli(project.root, 'lint', 'toolkit/', '--json');
    // A finding about a group surfaces whatever paths are named.
    expect(JSON.parse(narrowed.stdout)).toMatchObject({
      warnings: 1,
      findings: [{ rule: 'large-patch-files' }],
    });
  }, 60_000);
});

describe('a source-mode project with Furnace components', () => {
  it('judges the files its components deploy, in one group per component, with no deployment by hand', async () => {
    const project = await makeSourceProject(dir(), {
      config: { license: 'EUPL-1.2' },
      files: { 'src/browser/a.mjs': `${HEADER}export {};\n` },
    });
    const created = await cli(project.root, 'furnace', 'create', 'moz-acme-chip', '-d', 'A chip');
    expect(created.exitCode).toBe(ExitCode.SUCCESS);
    const vendored = 'toolkit/content/widgets/moz-acme-chip/moz-acme-chip-vendor.mjs';
    await writeTree(project.root, {
      'components/custom/moz-acme-chip/moz-acme-chip-vendor.mjs': 'export const vendored = 1;\n',
    });

    const groups = await cli(project.root, 'status', '--groups');
    expect(groups.stdout).toContain(', and 1 Furnace component(s)\n');
    expect(groups.stdout).toContain('  moz-acme-chip  furnace  3 path(s)\n');

    // The registration the component's files answer is found, and the vendored file is judged.
    const failed = await cli(project.root, 'lint', '--json');
    const report = JSON.parse(failed.stdout) as {
      findings: { rule: string; path: string | null; group: string | null }[];
    };
    expect(report.findings).toEqual([
      expect.objectContaining({
        rule: 'missing-license-header',
        path: vendored,
        group: 'moz-acme-chip',
      }),
    ]);

    // A waiver names the component, and its size is no finding however large it is.
    const configFile = join(project.root, 'fireforge.json');
    const config = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
    config['patchLint'] = {
      waivers: [{ group: 'moz-acme-chip', rule: 'missing-license-header', reason: 'Vendored.' }],
    };
    await writeFile(configFile, JSON.stringify(config));
    expect((await cli(project.root, 'lint')).exitCode).toBe(ExitCode.SUCCESS);

    // Leasing a workspace deploys the components, so validation judges this checkout.
    const validated = await cli(project.root, 'furnace', 'validate');
    expect(validated.stdout).not.toContain('deployment-stale');
    expect(validated.stdout).toContain('FIREFORGE-VERDICT: PASS');
  }, 120_000);
});

describe('fireforge typecheck', () => {
  it('checks the owned files in a leased workspace, and explains a file', async () => {
    const project = await makeSourceProject(dir(), {
      config: { license: 'EUPL-1.2', patchLint: { checkJs: true } },
      files: {
        'src/browser/A.sys.mjs': `${HEADER}/** @type {number} */\nexport const n = "x";\n`,
      },
    });
    const result = await cli(project.root, 'typecheck');
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.stdout).toContain(
      "[owned files] engine/browser/A.sys.mjs:3 error TS2322: Type 'string' is not assignable to type 'number'."
    );
    expect(result.stderr).toContain('--explain');
    const explained = await cli(
      project.root,
      'typecheck',
      '--explain',
      'engine/browser/A.sys.mjs',
      '--json'
    );
    expect(explained.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(explained.stdout)).toMatchObject({
      file: 'engine/browser/A.sys.mjs',
      owned: { program: 'module' },
    });
  }, 120_000);
  it('checks an engine project that names project files beside the engine, wherever the workspace is', async () => {
    const jsconfig = {
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        lib: ['ES2022'],
      },
      // Written for an engine at <project>/engine: four levels up is the project.
      include: ['*.js', '../../../../tools/types/globals.d.ts'],
    };
    const project = await makeSourceProject(dir(), {
      config: {
        license: 'EUPL-1.2',
        typecheck: {
          projects: ['engine/browser/modules/mine/jsconfig.json'],
          undefinedIdentifiers: 'error',
        },
      },
      files: {
        'tools/types/globals.d.ts': 'declare function mineGlobal(value: number): number;\n',
        'src/browser/modules/mine/jsconfig.json': JSON.stringify(jsconfig),
        'src/browser/modules/mine/a.js': `${HEADER}export const a = mineGlobal(1);\n`,
      },
    });
    const clean = await cli(project.root, 'typecheck');
    expect(clean.stdout).toContain('Typecheck: 0 error(s), 0 warning(s) across 1 project(s)');
    expect(clean.exitCode).toBe(ExitCode.SUCCESS);

    await writeTree(project.root, {
      'src/browser/modules/mine/a.js': `${HEADER}export const a = mineGlobal("one");\n`,
    });
    const failed = await cli(project.root, 'typecheck');
    expect(failed.exitCode).toBe(ExitCode.GENERAL_ERROR);
    // The file is named as the project names it, not by where the workspace is.
    expect(failed.stdout).toContain(
      '[engine/browser/modules/mine/jsconfig.json] engine/browser/modules/mine/a.js:2:'
    );
    expect(failed.stdout).toContain('TS2345');
  }, 120_000);
});
