// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace deploy --owner <patch>`: a deploy that would overwrite a deployed
 * file another patch owns refuses before any component is written. Two
 * sessions editing different files of one widget folder can then deploy
 * apart. Real filesystem, real git.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';

const logger = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  note: vi.fn(),
  notice: vi.fn(),
  verbose: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

const component = (tag: string): Record<string, unknown> => ({
  description: tag,
  targetPath: `toolkit/content/widgets/${tag}`,
  register: false,
  localized: false,
});

const FURNACE_CONFIG = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {},
  custom: { 'moz-a': component('moz-a'), 'moz-w': component('moz-w') },
};

const row = (filename: string, order: number, files: string[]): Record<string, unknown> => ({
  filename,
  order,
  category: 'ui',
  name: filename.replace(/^\d+-ui-|\.patch$/g, ''),
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  sourceEsrVersion: '140.9.0esr',
  filesAffected: files,
});

const W = 'toolkit/content/widgets/moz-w';
const A = 'toolkit/content/widgets/moz-a';

describe('furnace deploy --owner (integration)', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  const engineText = (path: string): Promise<string> =>
    readFile(join(projectRoot, 'engine', path), 'utf8');

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await writeFiles(projectRoot, {
      'furnace.json': `${JSON.stringify(FURNACE_CONFIG, null, 2)}\n`,
      'components/custom/moz-a/moz-a.mjs': 'export class MozA extends HTMLElement {}\n',
      'components/custom/moz-w/moz-w.mjs': 'export class MozW extends HTMLElement {}\n',
      'components/custom/moz-w/moz-w.css': ':host { display: block; }\n',
      'patches/patches.json': `${JSON.stringify({
        version: 1,
        patches: [
          row('001-ui-mine.patch', 1, [`${A}/moz-a.mjs`, `${W}/moz-w.mjs`]),
          row('002-ui-peer.patch', 2, [`${W}/moz-w.css`]),
        ],
      })}\n`,
      'patches/001-ui-mine.patch': '',
      'patches/002-ui-peer.patch': '',
    });
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'toolkit/content/jar.mn':
        '% content global %content/global/\n' +
        '   content/global/elements/moz-seed.mjs  (widgets/moz-seed/moz-seed.mjs)\n',
    });
    await furnaceDeployCommand(projectRoot, undefined, { skipValidate: true });
    vi.clearAllMocks();

    // This session edits files 001 owns; a peer has a half-done edit in
    // the file 002 owns, in the same widget folder.
    await writeFile(
      join(projectRoot, 'components/custom/moz-a/moz-a.mjs'),
      'export class MozA extends HTMLElement { mine() {} }\n'
    );
    await writeFile(
      join(projectRoot, 'components/custom/moz-w/moz-w.mjs'),
      'export class MozW extends HTMLElement { mine() {} }\n'
    );
    await writeFile(
      join(projectRoot, 'components/custom/moz-w/moz-w.css'),
      ':host { display: block; color: peer; }\n'
    );
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('refuses the whole deploy, writing nothing, when a file belongs to another patch', async () => {
    await expect(
      furnaceDeployCommand(projectRoot, ['moz-a', 'moz-w'], { owner: '001', skipValidate: true })
    ).rejects.toThrow(`${W}/moz-w.css (moz-w): owned by 002-ui-peer.patch`);
    // moz-a comes first and is entirely 001's, yet it is not deployed either.
    await expect(engineText(`${A}/moz-a.mjs`)).resolves.not.toContain('mine()');
    await expect(engineText(`${W}/moz-w.mjs`)).resolves.not.toContain('mine()');
    await expect(engineText(`${W}/moz-w.css`)).resolves.not.toContain('peer');
  });

  it('names the remedy and refuses a dry run the same way', async () => {
    await expect(
      furnaceDeployCommand(projectRoot, 'moz-w', { owner: '001', dryRun: true, skipValidate: true })
    ).rejects.toThrow(/Nothing was written\. .*Park that work or export that patch first/s);
  });

  it('deploys when every overwritten file is the owner patch’s', async () => {
    await furnaceDeployCommand(projectRoot, 'moz-a', { owner: '001', skipValidate: true });
    await expect(engineText(`${A}/moz-a.mjs`)).resolves.toContain('mine()');
  });

  it('refuses an --owner that names no patch in the queue', async () => {
    await expect(
      furnaceDeployCommand(projectRoot, 'moz-a', { owner: '999-nope', skipValidate: true })
    ).rejects.toThrow(/--owner: /);
    await expect(engineText(`${A}/moz-a.mjs`)).resolves.not.toContain('mine()');
  });

  it('overwrites with a warning, as before, without --owner', async () => {
    await furnaceDeployCommand(projectRoot, 'moz-w', { skipValidate: true });
    await expect(engineText(`${W}/moz-w.css`)).resolves.toContain('peer');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`overwriting deployed ${W}/moz-w.css`)
    );
  });
});
