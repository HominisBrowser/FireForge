// SPDX-License-Identifier: EUPL-1.2
/** The furnace commands through the CLI, in a patch-mode project whose engine is `engine/`. */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../testing/cli.js';
import { makeSourceProject, useMachSandbox } from '../testing/engine.js';
import { makeFurnaceFixture } from '../testing/furnace.js';
import { useTempDir } from '../testing/temp.js';

const dir = useTempDir();
useMachSandbox();

describe('fireforge furnace', () => {
  it('creates, applies, validates and keeps the typing files current', async () => {
    const f = await makeFurnaceFixture(dir(), {
      furnace: { version: 1, componentPrefix: 'moz-', typecheckTagMap: 'types/widgets.d.ts' },
    });
    const cwd = f.root;

    const created = await runCli(
      ['furnace', 'create', 'moz-acme-chip', '-d', 'A chip', '--tests', 'browser-chrome'],
      { cwd }
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain('changed components/custom/moz-acme-chip/moz-acme-chip.mjs');

    const dry = await runCli(['furnace', 'apply', '--dry-run', '--json'], { cwd });
    expect(JSON.parse(dry.stdout)).toMatchObject({ schemaVersion: 1, changed: true, dryRun: true });

    const applied = await runCli(['furnace', 'apply'], { cwd });
    expect(applied.stdout).toContain('deployed moz-acme-chip');
    expect(
      await readFile(join(f.engineDir, 'toolkit/content/customElements.js'), 'utf8')
    ).toContain('"moz-acme-chip"');
    expect((await runCli(['furnace', 'apply'], { cwd })).stdout).toBe('Components are current.\n');

    const status = await runCli(['furnace', 'status'], { cwd });
    expect(status.stdout).toBe('moz-acme-chip (custom) current\n');

    const validated = await runCli(['furnace', 'validate'], { cwd });
    expect(validated.exitCode).toBe(0);
    expect(validated.stdout).toMatch(
      /1 component\(s\): 0 error\(s\), 0 warning\(s\)\nFIREFORGE-VERDICT: PASS/
    );

    expect((await runCli(['furnace', 'types', '--check'], { cwd })).exitCode).toBe(0);
  });

  it('fails validation with exit code 9 and a failing verdict', async () => {
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
    const result = await runCli(['furnace', 'validate', '--json'], { cwd: f.root });
    expect(result.exitCode).toBe(9);
    const report = JSON.parse(result.stdout) as { pass: boolean; findings: { check: string }[] };
    expect(report.pass).toBe(false);
    expect(report.findings.map((finding) => finding.check)).toEqual([
      'missing-mjs',
      'raw-color-value',
      'deployment-stale',
    ]);
  });

  it('reports a stale typing file under --check', async () => {
    const f = await makeFurnaceFixture(dir(), {
      furnace: { version: 1, componentPrefix: 'moz-', typecheckTagMap: 'types/widgets.d.ts' },
    });
    const result = await runCli(['furnace', 'types', '--check'], { cwd: f.root });
    expect(result.exitCode).toBe(9);
    expect(result.stdout).toBe('types/widgets.d.ts: the file does not exist\n');
  });

  it('leaves a source-mode workspace undeployed under --dry-run and status, and reports what is pending', async () => {
    const project = await makeSourceProject(dir(), {
      files: {
        'furnace.json': JSON.stringify({
          version: 1,
          componentPrefix: 'moz-',
          custom: {
            'moz-test-chip': {
              description: 'A chip',
              targetPath: 'toolkit/content/widgets/moz-test-chip',
              register: true,
              localized: false,
            },
          },
        }),
        'components/custom/moz-test-chip/moz-test-chip.mjs':
          'export default class MozTestChip extends HTMLElement {}\n' +
          'customElements.define("moz-test-chip", MozTestChip);\n',
      },
    });
    const env = { FIREFORGE_HOME: project.host.root };
    const run = (args: string[]): ReturnType<typeof runCli> =>
      runCli(['furnace', ...args], { cwd: project.root, env });
    const chip = join(
      project.host.workspaces,
      'w1/engine/toolkit/content/widgets/moz-test-chip/moz-test-chip.mjs'
    );
    const held = (): Promise<boolean> =>
      stat(chip).then(
        () => true,
        () => false
      );

    const dry = await run(['apply', '--dry-run', '--json']);
    expect(JSON.parse(dry.stdout)).toMatchObject({ changed: true, dryRun: true });
    expect(await held()).toBe(false);
    const status = await run(['status']);
    expect(status.stdout).toContain('moz-test-chip (custom) outdated');
    expect(await held()).toBe(false);

    expect((await run(['apply'])).stdout).toContain('deployed moz-test-chip');
    expect(await held()).toBe(true);
    expect((await run(['status'])).stdout).toBe('moz-test-chip (custom) current\n');
  });
});
