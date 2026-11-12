// SPDX-License-Identifier: EUPL-1.2
/** `override`, `restore` and `merge-driver install` through the CLI. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../testing/cli.js';
import { makeSourceProject, useMachSandbox } from '../testing/engine.js';
import { git } from '../testing/git.js';
import { createSourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { TOKENS_CSS } from '../testing/tokens.js';

const dir = useTempDir();
const MANIFEST = 'browser/manifest.txt';

describe('override and restore', () => {
  it('declare an upstream file and give it back', async () => {
    const value = await createSourceFixture(dir());
    const env = await value.hostEnv();
    const declared = await runCli(['override', MANIFEST, '--component', 'ui-sidebar', '--json'], {
      cwd: join(value.root, 'src'),
      env,
    });
    expect(declared.exitCode).toBe(0);
    expect(JSON.parse(declared.stdout)).toMatchObject({
      schemaVersion: 1,
      path: MANIFEST,
      record: {
        kind: 'override',
        component: 'ui-sidebar',
        base: { commit: value.pristine.commit },
      },
    });
    await writeFile(join(value.root, 'src', MANIFEST), 'edited\n');
    const refused = await runCli(['restore', MANIFEST], { cwd: value.root, env });
    expect(refused.exitCode).toBe(8);
    expect(refused.stderr).toContain('--discard');
    const restored = await runCli(['restore', MANIFEST, '--discard'], { cwd: value.root, env });
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toBe(`${MANIFEST} is back to upstream.\n`);
    await expect(readFile(join(value.root, 'src', MANIFEST))).rejects.toThrow();
  });

  it('names the missing pristine repository and the command that fetches it', async () => {
    const value = await createSourceFixture(dir());
    const result = await runCli(['override', MANIFEST, '--json'], {
      cwd: value.root,
      env: { FIREFORGE_HOME: join(dir(), 'empty-home') },
    });
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'pristine-missing' });
  });

  it('refuses a patch-mode project', async () => {
    const root = join(dir(), 'patches');
    await git(dir(), ['init', '--quiet', root]);
    await writeFile(
      join(root, 'fireforge.json'),
      JSON.stringify({
        name: 'P',
        vendor: 'V',
        appId: 'org.example.p',
        binaryName: 'p',
        firefox: { version: '153.4.0esr', product: 'firefox-esr' },
      })
    );
    const result = await runCli(['restore', MANIFEST, '--json'], { cwd: root });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'source-mode-required' });
  });
});

describe('merge-driver install', () => {
  it('configures the driver with the ancestor label', async () => {
    const value = await createSourceFixture(dir());
    const result = await runCli(['merge-driver', 'install'], { cwd: value.root });
    expect(result.exitCode).toBe(0);
    expect(await git(value.root, ['config', '--get', 'merge.fireforge.driver'])).toMatch(
      / %O %A %B %P %S\n$/
    );
  });
});

describe('the authoring helpers in a source-mode project', () => {
  useMachSandbox();
  const PANEL = 'browser/base/content/panel.js';
  const JAR = 'browser/base/jar.mn';
  const TOKEN_FILE = 'browser/themes/shared/testbrowser-tokens.css';
  const cli = (root: string, ...args: string[]): ReturnType<typeof runCli> =>
    runCli(args, { cwd: root, env: { FIREFORGE_HOME: join(dir(), 'home') } });

  it('register declares its first touch of an upstream manifest and writes the owned copy', async () => {
    const project = await makeSourceProject(dir(), { files: { [`src/${PANEL}`]: '// panel\n' } });
    const registered = await cli(project.root, 'register', `src/${PANEL}`);
    expect(registered.exitCode).toBe(0);
    expect(registered.stdout).toContain(`Registered ${PANEL} in ${JAR}`);
    expect(await readFile(join(project.root, 'src', JAR), 'utf8')).toContain('(content/panel.js)');
    const record = JSON.parse(
      await readFile(join(project.root, 'upstream/overrides', `${JAR}.json`), 'utf8')
    ) as Record<string, unknown>;
    expect(record).toMatchObject({ kind: 'override', classification: 'registration' });
    expect((await cli(project.root, 'status', '--check')).exitCode).toBe(0);
    expect((await cli(project.root, 'register', PANEL)).stdout).toContain('Already registered');
  });

  it('token add edits the owned token file, and token lint reads the owned stylesheets', async () => {
    const project = await makeSourceProject(dir(), {
      files: {
        [`src/${TOKEN_FILE}`]: TOKENS_CSS.replaceAll('--acme-', '--testbrowser-'),
        'src/browser/themes/shared/panel.css': '.panel { gap: var(--testbrowser-missing); }\n',
      },
    });
    const added = await cli(
      project.root,
      ...['token', 'add', '--category', 'Spacing', '--mode', 'static', 'tight', '2px']
    );
    expect(added.exitCode).toBe(0);
    expect(await readFile(join(project.root, 'src', TOKEN_FILE), 'utf8')).toContain(
      '--testbrowser-tight: 2px;'
    );
    const linted = await cli(project.root, 'token', 'lint', '--json');
    expect(linted.exitCode).toBe(1);
    expect(JSON.parse(linted.stdout)).toMatchObject({
      findings: [{ file: 'browser/themes/shared/panel.css' }],
    });
  });

  it('a configured waiver suppresses the findings of its group only', async () => {
    const project = await makeSourceProject(dir(), {
      config: {
        license: 'EUPL-1.2',
        exportQueue: { groups: [{ name: 'ui-panel', paths: ['browser/base/content/**'] }] },
        patchLint: {
          waivers: [{ group: 'ui-panel', rule: 'missing-license-header', reason: 'vendored' }],
        },
      },
      files: { [`src/${PANEL}`]: '// panel\n', 'src/toolkit/mine/other.js': '// other\n' },
    });
    const result = await cli(project.root, 'lint', '--json');
    const { findings } = JSON.parse(result.stdout) as {
      findings: { rule: string; path?: string }[];
    };
    expect(findings.filter((finding) => finding.rule === 'missing-license-header')).toMatchObject([
      { path: 'toolkit/mine/other.js' },
    ]);
  });

  it('typecheck refuses while a typing file Furnace generates is out of date', async () => {
    const project = await makeSourceProject(dir(), {
      files: {
        'furnace.json': JSON.stringify({
          componentPrefix: 'moz-',
          custom: {
            'moz-thing': {
              description: 'A thing',
              targetPath: 'toolkit/content/widgets/moz-thing',
              register: true,
              localized: false,
            },
          },
          typecheckTagMap: 'types/tag-map.d.ts',
        }),
        'components/custom/moz-thing/moz-thing.mjs':
          'export class MozThing extends HTMLElement {}\ncustomElements.define("moz-thing", MozThing);\n',
      },
    });
    const refused = await cli(project.root, 'typecheck');
    expect(refused.stderr).toContain('fireforge furnace types');
    expect(refused.exitCode).toBe(9);
  });
});
