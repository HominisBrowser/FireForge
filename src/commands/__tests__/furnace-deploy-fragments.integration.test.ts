// SPDX-License-Identifier: EUPL-1.2
/**
 * Targeted `furnace deploy <tag>` and the OTHER deployed includers of a
 * shared fragment `<tag>` includes. Real filesystem, real git.
 */
import { access, readFile, rm, writeFile } from 'node:fs/promises';
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
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

const FURNACE_CONFIG = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {},
  custom: {
    'moz-a': {
      description: 'A',
      targetPath: 'toolkit/content/widgets/moz-a',
      register: false,
      localized: false,
    },
    'moz-b': {
      description: 'B',
      targetPath: 'toolkit/content/widgets/moz-b',
      register: false,
      localized: false,
    },
  },
} as const;

const SHEET = [
  ':host { display: block; }',
  '/* @fireforge-include shared-anims.css */',
  '.local { color: red; }',
  '',
].join('\n');

const FRAGMENT_V1 = '@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }\n';
const FRAGMENT_V2 = '@keyframes spin { to { rotate: 1turn; } }\n';

describe('furnace deploy fragment includers (integration)', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  const engineSheet = (tag: string): string =>
    join(projectRoot, 'engine', 'toolkit', 'content', 'widgets', tag, `${tag}.css`);

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();

    await writeFireForgeConfig(projectRoot);
    await writeFiles(projectRoot, {
      'furnace.json': `${JSON.stringify(FURNACE_CONFIG, null, 2)}\n`,
      'components/shared/shared-anims.css': FRAGMENT_V1,
      'components/custom/moz-a/moz-a.mjs': 'export class MozA extends HTMLElement {}\n',
      'components/custom/moz-a/moz-a.css': SHEET,
      'components/custom/moz-b/moz-b.mjs': 'export class MozB extends HTMLElement {}\n',
      'components/custom/moz-b/moz-b.css': SHEET,
    });
    // The custom apply registers every component's files in
    // toolkit/content/jar.mn, so the engine tree needs that file.
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'README.txt': 'baseline\n',
      'toolkit/content/jar.mn':
        '% content global %content/global/\n' +
        '   content/global/elements/moz-seed.mjs  (widgets/moz-seed/moz-seed.mjs)\n',
    });

    await furnaceDeployCommand(projectRoot, undefined, { skipValidate: true });
    expect(await readFile(engineSheet('moz-b'), 'utf8')).toContain('@keyframes pulse');
    vi.clearAllMocks();

    await writeFile(join(projectRoot, 'components', 'shared', 'shared-anims.css'), FRAGMENT_V2);
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('targeted deploy of one includer refreshes the other deployed includer of the edited fragment', async () => {
    await furnaceDeployCommand(projectRoot, 'moz-a', { skipValidate: true });

    expect(await readFile(engineSheet('moz-a'), 'utf8')).toContain('@keyframes spin');
    expect(await readFile(engineSheet('moz-b'), 'utf8')).toContain('@keyframes spin');
    expect(await readFile(engineSheet('moz-b'), 'utf8')).not.toContain('@keyframes pulse');
    expect(logger.notice).toHaveBeenCalledWith(
      'Also refreshed 1 other includer of "shared-anims.css": moz-b.'
    );

    const state = JSON.parse(
      await readFile(join(projectRoot, '.fireforge', 'furnace-state.json'), 'utf8')
    ) as { appliedChecksums: Record<string, string> };
    expect(Object.keys(state.appliedChecksums).some((k) => k.startsWith('custom/moz-b/'))).toBe(
      true
    );
  });

  it('targeted dry-run reports the would-be refresh and writes nothing', async () => {
    await furnaceDeployCommand(projectRoot, 'moz-a', { dryRun: true, skipValidate: true });

    expect(await readFile(engineSheet('moz-b'), 'utf8')).toContain('@keyframes pulse');
    expect(await readFile(engineSheet('moz-a'), 'utf8')).toContain('@keyframes pulse');
    expect(logger.notice).toHaveBeenCalledWith(
      'Would also refresh 1 other includer of "shared-anims.css": moz-b.'
    );
  });

  it('leaves an undeployed includer alone', async () => {
    await rm(join(projectRoot, 'engine', 'toolkit', 'content', 'widgets', 'moz-b'), {
      recursive: true,
      force: true,
    });

    await furnaceDeployCommand(projectRoot, 'moz-a', { skipValidate: true });

    await expect(access(engineSheet('moz-b'))).rejects.toThrow();
    expect(logger.notice).not.toHaveBeenCalled();
  });
});
