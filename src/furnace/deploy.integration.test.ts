// SPDX-License-Identifier: EUPL-1.2
/**
 * Deployment against a real synthetic engine: what lands where, what an
 * unchanged run costs, what is taken away, and that a failure or an
 * interrupted run leaves the engine and its record consistent.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { transaction } from '../kernel/journal.js';
import * as log from '../kernel/log.js';
import { type FurnaceFixture, makeFurnaceFixture } from '../testing/furnace.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { applyComponents, deploymentStatus } from './index.js';

const dir = useTempDir();

const CHIP_MJS = `import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
export default class MozAcmeChip extends MozLitElement {}
customElements.define("moz-acme-chip", MozAcmeChip);
`;

const FURNACE = {
  version: 1,
  componentPrefix: 'moz-',
  custom: {
    'moz-acme-chip': {
      description: 'A chip',
      targetPath: 'toolkit/content/widgets/moz-acme-chip',
      register: true,
      localized: true,
    },
  },
};

const CHIP_FILES = {
  'components/custom/moz-acme-chip/moz-acme-chip.mjs': CHIP_MJS,
  'components/custom/moz-acme-chip/moz-acme-chip.css':
    ':host { color: var(--acme-text); }\n/* @fireforge-include base.css */\n',
  'components/custom/moz-acme-chip/moz-acme-chip.ftl': 'chip-label = Chip\n',
  'components/shared/base.css': ':host { display: block; }\n',
};

async function fixture(
  furnace: object = FURNACE,
  files: object = CHIP_FILES
): Promise<FurnaceFixture> {
  return makeFurnaceFixture(dir(), { furnace, files: files as Record<string, string> });
}

const engine = (f: FurnaceFixture, path: string): Promise<string> =>
  readFile(join(f.engineDir, path), 'utf8');
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  );

const CHIP = 'toolkit/content/widgets/moz-acme-chip';

describe('applyComponents', () => {
  it('deploys files, the jar lines and the element entry, then costs nothing', async () => {
    const f = await fixture();
    const first = await applyComponents(f.project, f.workspace);
    expect(first.changed).toBe(true);
    expect(first.written).toEqual([
      'toolkit/content/customElements.js',
      'toolkit/content/jar.mn',
      `${CHIP}/moz-acme-chip.css`,
      `${CHIP}/moz-acme-chip.mjs`,
      'toolkit/locales/en-US/toolkit/global/moz-acme-chip.ftl',
    ]);
    expect(await engine(f, `${CHIP}/moz-acme-chip.mjs`)).toBe(CHIP_MJS);
    expect(await engine(f, `${CHIP}/moz-acme-chip.css`)).toBe(
      ':host { color: var(--acme-text); }\n/* @fireforge-include base.css */\n:host { display: block; }\n/* @fireforge-end-include base.css */\n'
    );
    const jar = await engine(f, 'toolkit/content/jar.mn');
    expect(jar).toContain(
      'content/global/elements/moz-acme-chip.mjs  (widgets/moz-acme-chip/moz-acme-chip.mjs)'
    );
    expect(await engine(f, 'toolkit/content/customElements.js')).toContain(
      '["moz-acme-chip", "chrome://global/content/elements/moz-acme-chip.mjs"],  // ACME:'
    );

    const mtime = (await stat(join(f.engineDir, 'toolkit/content/jar.mn'))).mtimeMs;
    const second = await applyComponents(f.project, f.workspace);
    expect(second.changed).toBe(false);
    expect(second.components).toEqual([
      { name: 'moz-acme-chip', kind: 'custom', status: 'current', reasons: [] },
    ]);
    expect((await stat(join(f.engineDir, 'toolkit/content/jar.mn'))).mtimeMs).toBe(mtime);
    expect((await deploymentStatus(f.project, f.workspace)).current).toBe(true);
  });

  it('redeploys what changed in the project, a fragment edit included, and what the engine lost', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    await writeTree(f.root, { 'components/shared/base.css': ':host { display: flex; }\n' });
    await rm(join(f.engineDir, `${CHIP}/moz-acme-chip.mjs`));
    const status = await deploymentStatus(f.project, f.workspace);
    expect(status.current).toBe(false);
    expect(status.components[0]?.reasons).toEqual([
      `${CHIP}/moz-acme-chip.css changed in the project`,
      `${CHIP}/moz-acme-chip.mjs is missing from the engine`,
    ]);
    const result = await applyComponents(f.project, f.workspace);
    expect(result.written).toEqual([`${CHIP}/moz-acme-chip.css`, `${CHIP}/moz-acme-chip.mjs`]);
    expect(await engine(f, `${CHIP}/moz-acme-chip.css`)).toContain('display: flex');
  });

  it('takes away a file the component dropped, with its jar line, and the entry when the module goes', async () => {
    const f = await fixture(FURNACE, {
      ...CHIP_FILES,
      'components/custom/moz-acme-chip/moz-acme-chip-rows.mjs': 'export const rows = 1;\n',
    });
    await applyComponents(f.project, f.workspace);
    expect(await engine(f, 'toolkit/content/jar.mn')).toContain('moz-acme-chip-rows.mjs');
    await rm(join(f.root, 'components/custom/moz-acme-chip/moz-acme-chip-rows.mjs'));
    await rm(join(f.root, 'components/custom/moz-acme-chip/moz-acme-chip.mjs'));
    const result = await applyComponents(f.project, f.workspace);
    expect(result.removed).toEqual([`${CHIP}/moz-acme-chip-rows.mjs`, `${CHIP}/moz-acme-chip.mjs`]);
    expect(await exists(join(f.engineDir, `${CHIP}/moz-acme-chip-rows.mjs`))).toBe(false);
    const jar = await engine(f, 'toolkit/content/jar.mn');
    expect(jar).not.toContain('moz-acme-chip.mjs');
    expect(jar).toContain('moz-acme-chip.css');
    expect(await engine(f, 'toolkit/content/customElements.js')).not.toContain('moz-acme-chip');
  });

  it('undeploys a component no longer configured', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    await writeFile(
      f.project.paths.furnace,
      JSON.stringify({ version: 1, componentPrefix: 'moz-' })
    );
    const result = await applyComponents(f.project, f.workspace);
    expect(result.components).toEqual([
      {
        name: 'moz-acme-chip',
        kind: 'custom',
        status: 'removed',
        reasons: ['it is no longer in furnace.json'],
      },
    ]);
    expect(await exists(join(f.engineDir, CHIP, 'moz-acme-chip.mjs'))).toBe(false);
    expect(
      await exists(join(f.engineDir, 'toolkit/locales/en-US/toolkit/global/moz-acme-chip.ftl'))
    ).toBe(false);
    expect(await engine(f, 'toolkit/content/jar.mn')).not.toContain('moz-acme-chip');
    expect(await engine(f, 'toolkit/content/customElements.js')).not.toContain('moz-acme-chip');
    expect((await applyComponents(f.project, f.workspace)).changed).toBe(false);
  });

  it('deploys an override over the stock files and puts upstream back when it goes', async () => {
    const override = {
      version: 1,
      componentPrefix: 'moz-',
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Square card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '153.7.0esr',
        },
      },
    };
    const f = await fixture(override, {
      'components/overrides/moz-card/moz-card.css': ':host { border-radius: 0; }\n',
      'components/overrides/moz-card/moz-card-extra.css': ':host { gap: 0; }\n',
      'components/overrides/moz-card/moz-card.mjs': '// not deployed by a css-only override\n',
    });
    const stock = await engine(f, 'toolkit/content/widgets/moz-card/moz-card.css');
    const result = await applyComponents(f.project, f.workspace);
    expect(result.written).toEqual([
      'toolkit/content/widgets/moz-card/moz-card-extra.css',
      'toolkit/content/widgets/moz-card/moz-card.css',
    ]);
    expect(await engine(f, 'toolkit/content/widgets/moz-card/moz-card.mjs')).toContain('MozCard');
    await writeFile(
      f.project.paths.furnace,
      JSON.stringify({ version: 1, componentPrefix: 'moz-' })
    );
    await applyComponents(f.project, f.workspace);
    expect(await engine(f, 'toolkit/content/widgets/moz-card/moz-card.css')).toBe(stock);
    expect(
      await exists(join(f.engineDir, 'toolkit/content/widgets/moz-card/moz-card-extra.css'))
    ).toBe(false);
  });

  it('plans without writing on a dry run', async () => {
    const f = await fixture();
    const plan = await applyComponents(f.project, f.workspace, { dryRun: true });
    expect(plan.changed).toBe(true);
    expect(await exists(join(f.engineDir, CHIP))).toBe(false);
    expect(await exists(join(f.workspace.stateDir, 'furnace-deployment.json'))).toBe(false);
  });

  it('refuses a missing fragment before writing anything', async () => {
    const f = await fixture();
    await rm(join(f.root, 'components/shared/base.css'));
    await expect(applyComponents(f.project, f.workspace)).rejects.toMatchObject({
      code: 'furnace-fragment-missing',
      exitCode: 9,
    });
    expect(await exists(join(f.engineDir, CHIP))).toBe(false);
  });

  it('rolls every write back when one fails, keeping the old record', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    const record = await readFile(join(f.workspace.stateDir, 'furnace-deployment.json'), 'utf8');
    await writeTree(f.root, {
      'components/custom/moz-acme-chip/moz-acme-chip.css': ':host { color: red; }\n',
      'components/custom/moz-acme-chip/moz-acme-chip.mjs': `${CHIP_MJS}// changed\n`,
    });
    await rm(join(f.engineDir, `${CHIP}/moz-acme-chip.mjs`));
    await writeTree(f.engineDir, {
      [`${CHIP}/moz-acme-chip.mjs/blocker`]: 'a directory in the way',
    });
    await expect(applyComponents(f.project, f.workspace)).rejects.toThrow();
    expect(await engine(f, `${CHIP}/moz-acme-chip.css`)).toContain('var(--acme-text)');
    expect(await readFile(join(f.workspace.stateDir, 'furnace-deployment.json'), 'utf8')).toBe(
      record
    );
  });

  it('undoes an interrupted run before planning the next', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    const journal = join(f.workspace.stateDir, 'furnace-deployment.journal');
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await once(dead, 'exit');
    let snapshot = '';
    const copies = new Map<string, Buffer>();
    const half = join(f.engineDir, `${CHIP}/moz-acme-chip.css`);
    await transaction(journal, 'the component deployment', async (tx) => {
      await tx.write(half, 'half written\n');
      snapshot = await readFile(journal, 'utf8');
      for (const name of await readdir(`${journal}.d`)) {
        copies.set(name, await readFile(join(`${journal}.d`, name)));
      }
    });
    await writeFile(half, 'half written\n');
    for (const [name, bytes] of copies) await writeTree(`${journal}.d`, { [name]: bytes });
    const [header = '', ...entries] = snapshot.split('\n');
    const forged = JSON.stringify({
      ...(JSON.parse(header) as object),
      pid: dead.pid,
      start: 'gone',
    });
    await writeFile(journal, [forged, ...entries].join('\n'));
    const warnings: string[] = [];
    const previous = log.configureLog({ write: (text) => warnings.push(text) });
    try {
      const result = await applyComponents(f.project, f.workspace);
      expect(result.changed).toBe(false);
    } finally {
      log.configureLog(previous);
    }
    expect(warnings.join('')).toContain('Undid an interrupted run of the component deployment');
    expect(await engine(f, `${CHIP}/moz-acme-chip.css`)).toContain('var(--acme-text)');
  });

  it('serialises two deployments into one workspace', async () => {
    const f = await fixture();
    const results = await Promise.all([
      applyComponents(f.project, f.workspace),
      applyComponents(f.project, f.workspace),
    ]);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect((await deploymentStatus(f.project, f.workspace)).current).toBe(true);
  });

  it('adopts an engine that already holds the components, writing only the record', async () => {
    const f = await fixture();
    await applyComponents(f.project, f.workspace);
    await rm(join(f.workspace.stateDir, 'furnace-deployment.json'));
    const result = await applyComponents(f.project, f.workspace);
    expect(result.changed).toBe(false);
    expect(await exists(join(f.workspace.stateDir, 'furnace-deployment.json'))).toBe(true);
  });
});
