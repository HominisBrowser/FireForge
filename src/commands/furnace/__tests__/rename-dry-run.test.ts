// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace rename --dry-run` renders every edit the real rename would make,
 * from reads only.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CustomComponentConfig, FurnaceConfig } from '../../../types/furnace.js';
import { type RenamePlanInput, renderRenamePlan } from '../rename-dry-run.js';

const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';
const LOCALE_JAR = 'toolkit/locales/jar.mn';

let root: string;
let engineDir: string;
let oldDir: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function custom(entry: Partial<CustomComponentConfig> = {}): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-old': {
        description: 'The moz-old widget',
        targetPath: 'toolkit/content/widgets/moz-old',
        register: true,
        localized: false,
        ...entry,
      },
    },
  };
}

function input(config: FurnaceConfig, overrides: Partial<RenamePlanInput> = {}): RenamePlanInput {
  return {
    config,
    oldName: 'moz-old',
    newName: 'moz-new',
    oldDir,
    componentDirLabel: 'custom',
    engineDir,
    markerComment: 'MYBROWSER',
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ff-rename-plan-'));
  engineDir = join(root, 'engine');
  oldDir = join(root, 'components', 'custom', 'moz-old');
  await put(join(oldDir, 'moz-old.mjs'), 'export class MozOld {}\n');
  await put(join(oldDir, 'moz-old.css'), ':host {}\n');
  await put(join(oldDir, 'notes.txt'), 'notes\n');
  await mkdir(engineDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('renderRenamePlan', () => {
  it('lists workspace moves and the description rewrite, and stops without an engine', async () => {
    await rm(engineDir, { recursive: true });

    const plan = await renderRenamePlan(input(custom()));

    expect(plan).toContain('Workspace: components/custom/moz-old/ → components/custom/moz-new/');
    expect(plan).toContain('  moz-old.css → moz-new.css (tag and class references rewritten)');
    expect(plan).toContain('  notes.txt\n');
    expect(plan).toContain('  description: "The moz-old widget" → "The moz-new widget"');
    expect(plan).not.toContain('Engine:');
  });

  it('plans an in-place customElements rewrite and the jar line swap', async () => {
    await put(
      join(engineDir, 'toolkit/content/customElements.js'),
      '    ["moz-old", "chrome://global/content/elements/moz-old.mjs"],  // MYBROWSER:\n'
    );
    await put(
      join(engineDir, 'toolkit/content/jar.mn'),
      '  content/global/elements/moz-old.mjs  (widgets/moz-old/moz-old.mjs)\n'
    );
    await mkdir(join(engineDir, 'toolkit/content/widgets/moz-old'), { recursive: true });

    const plan = await renderRenamePlan(input(custom()));

    expect(plan).toContain(
      'customElements.js: rewrite the "moz-old" entry in place as "moz-new" (position and marker comments kept)'
    );
    expect(plan).toContain(
      'toolkit/content/jar.mn: replace 1 "moz-old" line(s) with moz-new.css, moz-new.mjs'
    );
    expect(plan).toContain('remove the stale deployed directory toolkit/content/widgets/moz-old/');
    expect(plan).toContain('Test scaffolds named after the old tag are renamed when present.');
  });

  it('plans a fresh marked entry when none exists, and none at all without a marker', async () => {
    await put(join(engineDir, 'toolkit/content/customElements.js'), '// empty\n');

    expect(await renderRenamePlan(input(custom()))).toContain(
      'customElements.js: add a "moz-new" entry marked // MYBROWSER:'
    );
    const unmarked = await renderRenamePlan(input(custom(), { markerComment: undefined }));
    expect(unmarked).toContain('customElements.js: add a "moz-new" entry\n');
  });

  it('says when the new tag is already registered', async () => {
    const both =
      '    ["moz-new", "chrome://global/content/elements/moz-new.mjs"],\n' +
      '    ["moz-old", "chrome://global/content/elements/moz-old.mjs"],\n';
    await put(join(engineDir, 'toolkit/content/customElements.js'), both);
    expect(await renderRenamePlan(input(custom()))).toContain(
      'customElements.js: "moz-new" is already registered; remove the "moz-old" entry'
    );

    await put(
      join(engineDir, 'toolkit/content/customElements.js'),
      '    ["moz-new", "chrome://global/content/elements/moz-new.mjs"],\n'
    );
    const plan = await renderRenamePlan(input(custom()));
    expect(plan).toContain('customElements.js: "moz-new" is already registered\n');
  });

  it('names a jar with no .mjs/.css to register', async () => {
    await rm(join(oldDir, 'moz-old.mjs'));
    await rm(join(oldDir, 'moz-old.css'));
    await put(join(engineDir, 'toolkit/content/jar.mn'), 'toolkit.jar:\n');

    expect(await renderRenamePlan(input(custom()))).toContain(
      'replace 0 "moz-old" line(s) with none (no .mjs/.css files)'
    );
  });

  it('re-points an existing per-component locale line and renames the .ftl', async () => {
    await put(join(engineDir, FTL_DIR, 'moz-old.ftl'), 'old = Old\n');
    await put(
      join(engineDir, LOCALE_JAR),
      '  locale/@AB_CD@/toolkit/global/moz-old.ftl (%toolkit/global/moz-old.ftl)\n'
    );

    const plan = await renderRenamePlan(input(custom({ localized: true })));

    expect(plan).toContain(`${FTL_DIR}/moz-old.ftl → moz-new.ftl`);
    expect(plan).toContain(`${LOCALE_JAR}: re-point the "moz-old.ftl" line to "moz-new.ftl"`);
  });

  it('leaves the locale jar alone when there is no line to re-point', async () => {
    await put(join(engineDir, LOCALE_JAR), '\n');

    expect(await renderRenamePlan(input(custom({ localized: true })))).toContain(
      `${LOCALE_JAR}: no "moz-old.ftl" line to re-point (left unchanged)`
    );
  });

  it('never plans a per-component locale line for a sharedFtl component', async () => {
    await put(join(engineDir, LOCALE_JAR), '\n');
    const shared = custom({ localized: true, sharedFtl: 'browser/mybrowser-shared.ftl' });
    expect(await renderRenamePlan(input(shared))).toContain(
      `${LOCALE_JAR}: no per-component line (sharedFtl: browser/mybrowser-shared.ftl)\n`
    );

    await put(
      join(engineDir, LOCALE_JAR),
      '  locale/@AB_CD@/toolkit/global/moz-old.ftl (%toolkit/global/moz-old.ftl)\n'
    );
    expect(await renderRenamePlan(input(shared))).toContain(
      '; remove the stale "moz-old.ftl" line'
    );
  });

  it('leaves registrations alone for an unregistered component', async () => {
    const plan = await renderRenamePlan(input(custom({ register: false })));

    expect(plan).toContain('registrations untouched (register: false)');
    expect(plan).not.toContain('customElements.js');
  });

  it('renders an override as a workspace move only', async () => {
    const config: FurnaceConfig = {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-old': {
          type: 'css-only',
          description: 'Restyle',
          basePath: 'toolkit/content/widgets/moz-old',
          baseVersion: '145.0',
        },
      },
      custom: {},
    };

    const plan = await renderRenamePlan(input(config, { componentDirLabel: 'overrides' }));

    expect(plan).toContain('components/overrides/moz-old/ → components/overrides/moz-new/');
    expect(plan).not.toContain('description:');
    expect(plan).not.toContain('Engine:');
  });
});
