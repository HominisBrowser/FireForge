// SPDX-License-Identifier: EUPL-1.2
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as prompts from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as furnaceConfigModule from '../../core/furnace-config.js';
import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { furnaceCreateCommand } from '../furnace/create.js';
import { furnaceOverrideCommand } from '../furnace/override.js';
import { furnaceRemoveCommand } from '../furnace/remove.js';

const logger = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
}));

// Re-export the real furnace-config module with a mockable writeFurnaceConfig
// so individual tests can inject failures into the config-write step.
vi.mock('../../core/furnace-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/furnace-config.js')>(
    '../../core/furnace-config.js'
  );
  return {
    ...actual,
    writeFurnaceConfig: vi.fn(actual.writeFurnaceConfig),
  };
});

// The custom-element AST registration parses real Firefox source. Stub it so
// we don't need a complete customElements.js fixture for these tests.
vi.mock('../../core/furnace-registration-ast.js', () => ({
  addCustomElementRegistration: vi.fn(async () => {}),
  removeCustomElementRegistration: vi.fn(async () => {}),
}));

// `furnace remove` requires the engine to be a git repository for both the
// override and custom paths so deleted edits can be recovered. The temp
// project here is a plain filesystem fixture, so stub the git-detection
// helper so the rollback test can focus on the journal contract rather
// than the engine bootstrap precondition.
vi.mock('../../core/git.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/git.js')>('../../core/git.js');
  return {
    ...actual,
    isGitRepository: vi.fn(() => Promise.resolve(true)),
  };
});

const VALID_FURNACE = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {},
  custom: {},
} as const;

async function pathPresent(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('Furnace authoring rollback integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-authoring-');
    await writeFireForgeConfig(projectRoot);
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  describe('validation runs before furnace.json is auto-created', () => {
    it('create rejects an invalid name without writing furnace.json', async () => {
      // Running ensureFurnaceConfig() before validation leaves a fresh
      // furnace.json behind in any directory after a CLI typo.
      await expect(
        furnaceCreateCommand(projectRoot, 'NoHyphen', { description: 'Bad name' })
      ).rejects.toThrow(InvalidArgumentError);

      expect(await pathPresent(join(projectRoot, 'furnace.json'))).toBe(false);
    });

    it('create rejects when name is missing in non-interactive mode without writing furnace.json', async () => {
      await expect(
        furnaceCreateCommand(projectRoot, undefined, { description: 'No name' })
      ).rejects.toThrow(InvalidArgumentError);

      expect(await pathPresent(join(projectRoot, 'furnace.json'))).toBe(false);
    });

    it('override rejects an invalid name without writing furnace.json', async () => {
      await expect(
        furnaceOverrideCommand(projectRoot, 'INVALID', { type: 'full', description: 'x' })
      ).rejects.toThrow(InvalidArgumentError);

      expect(await pathPresent(join(projectRoot, 'furnace.json'))).toBe(false);
    });

    it('override rejects when name is missing in non-interactive mode without writing furnace.json', async () => {
      await expect(
        furnaceOverrideCommand(projectRoot, undefined, { type: 'full', description: 'x' })
      ).rejects.toThrow(InvalidArgumentError);

      expect(await pathPresent(join(projectRoot, 'furnace.json'))).toBe(false);
    });

    it('create cancellation in interactive mode does not write furnace.json', async () => {
      restoreTTY?.();
      restoreTTY = setInteractiveMode(true);
      vi.mocked(prompts.text).mockResolvedValueOnce(Symbol('cancel'));
      logger.isCancel.mockReturnValueOnce(true);

      await furnaceCreateCommand(projectRoot);

      expect(await pathPresent(join(projectRoot, 'furnace.json'))).toBe(false);
    });

    it('override cancellation in interactive mode does not write furnace.json', async () => {
      restoreTTY?.();
      restoreTTY = setInteractiveMode(true);
      await writeFiles(projectRoot, {
        'engine/toolkit/content/widgets/moz-fake/moz-fake.mjs': '// fake mjs\n',
      });
      vi.mocked(prompts.select).mockResolvedValueOnce(Symbol('cancel'));
      logger.isCancel.mockReturnValueOnce(true);

      await furnaceOverrideCommand(projectRoot);

      expect(await pathPresent(join(projectRoot, 'furnace.json'))).toBe(false);
    });
  });

  describe('create rolls back partial state on failure', () => {
    it('removes scaffolded component files when writeFurnaceConfig throws', async () => {
      // Seed an existing config so the failure mid-write must not strand
      // either component files or a partially mutated config.
      await writeFiles(projectRoot, {
        'furnace.json': `${JSON.stringify(VALID_FURNACE, null, 2)}\n`,
      });
      const originalConfig = await readFile(join(projectRoot, 'furnace.json'), 'utf8');

      // Force writeFurnaceConfig to throw the first time it is called.
      const writeSpy = vi.mocked(furnaceConfigModule.writeFurnaceConfig);
      const realWrite = (
        await vi.importActual<typeof furnaceConfigModule>('../../core/furnace-config.js')
      ).writeFurnaceConfig;
      writeSpy.mockImplementationOnce(() => {
        throw new Error('simulated disk full');
      });

      try {
        await expect(
          furnaceCreateCommand(projectRoot, 'moz-rollback-widget', {
            description: 'Rollback test',
          })
        ).rejects.toThrow(/simulated disk full/);
      } finally {
        writeSpy.mockImplementation(realWrite);
      }

      // Component files must be gone
      const componentDir = join(projectRoot, 'components/custom/moz-rollback-widget');
      expect(await pathPresent(componentDir)).toBe(false);

      // furnace.json must be untouched (the failed write was the very first
      // call, so no on-disk mutation could have happened anyway, but verify).
      const after = await readFile(join(projectRoot, 'furnace.json'), 'utf8');
      expect(after).toBe(originalConfig);
    });
  });

  describe('override rolls back partial state on failure', () => {
    it('removes copied files when writeFurnaceConfig throws', async () => {
      // Set up a fake engine with a single component to override.
      await writeFiles(projectRoot, {
        'furnace.json': `${JSON.stringify(VALID_FURNACE, null, 2)}\n`,
        'engine/toolkit/content/widgets/moz-fake/moz-fake.mjs': '// fake mjs\n',
        'engine/toolkit/content/widgets/moz-fake/moz-fake.css': '/* fake css */\n',
      });
      const originalConfig = await readFile(join(projectRoot, 'furnace.json'), 'utf8');

      const writeSpy = vi.mocked(furnaceConfigModule.writeFurnaceConfig);
      const realWrite = (
        await vi.importActual<typeof furnaceConfigModule>('../../core/furnace-config.js')
      ).writeFurnaceConfig;
      writeSpy.mockImplementationOnce(() => {
        throw new Error('simulated disk full');
      });

      try {
        await expect(
          furnaceOverrideCommand(projectRoot, 'moz-fake', {
            type: 'full',
            description: 'Test',
          })
        ).rejects.toThrow(/simulated disk full/);
      } finally {
        writeSpy.mockImplementation(realWrite);
      }

      const overrideDir = join(projectRoot, 'components/overrides/moz-fake');
      expect(await pathPresent(overrideDir)).toBe(false);

      const after = await readFile(join(projectRoot, 'furnace.json'), 'utf8');
      expect(after).toBe(originalConfig);
    });
  });

  describe('remove rolls back partial state on failure', () => {
    it('restores deleted component files and engine artifacts when writeFurnaceConfig throws', async () => {
      const seedFurnace = {
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-rollback-widget': {
            description: 'Rollback test widget',
            targetPath: 'toolkit/content/widgets/moz-rollback-widget',
            register: false,
            localized: false,
          },
        },
      };

      await writeFiles(projectRoot, {
        'furnace.json': `${JSON.stringify(seedFurnace, null, 2)}\n`,
        'components/custom/moz-rollback-widget/moz-rollback-widget.mjs': '// component mjs\n',
        'components/custom/moz-rollback-widget/moz-rollback-widget.css': '/* component css */\n',
        'engine/toolkit/content/jar.mn':
          '% content global %content/global/\n' +
          '   content/global/elements/moz-rollback-widget.mjs  (widgets/moz-rollback-widget/moz-rollback-widget.mjs)\n',
        'engine/toolkit/content/widgets/moz-rollback-widget/moz-rollback-widget.mjs':
          '// deployed mjs\n',
      });

      const originalFurnace = await readFile(join(projectRoot, 'furnace.json'), 'utf8');
      const originalJarMn = await readFile(
        join(projectRoot, 'engine/toolkit/content/jar.mn'),
        'utf8'
      );
      const originalComponentMjs = await readFile(
        join(projectRoot, 'components/custom/moz-rollback-widget/moz-rollback-widget.mjs'),
        'utf8'
      );
      const originalDeployedMjs = await readFile(
        join(
          projectRoot,
          'engine/toolkit/content/widgets/moz-rollback-widget/moz-rollback-widget.mjs'
        ),
        'utf8'
      );

      // Force writeFurnaceConfig (the very last step in remove) to throw, so
      // every prior delete must be rolled back.
      const writeSpy = vi.mocked(furnaceConfigModule.writeFurnaceConfig);
      const realWrite = (
        await vi.importActual<typeof furnaceConfigModule>('../../core/furnace-config.js')
      ).writeFurnaceConfig;
      writeSpy.mockImplementationOnce(() => {
        throw new Error('simulated disk full');
      });

      try {
        await expect(
          furnaceRemoveCommand(projectRoot, 'moz-rollback-widget', { yes: true })
        ).rejects.toThrow(/simulated disk full/);
      } finally {
        writeSpy.mockImplementation(realWrite);
      }

      // furnace.json must still describe the component
      expect(await readFile(join(projectRoot, 'furnace.json'), 'utf8')).toBe(originalFurnace);

      // Workspace component files must be restored
      expect(
        await readFile(
          join(projectRoot, 'components/custom/moz-rollback-widget/moz-rollback-widget.mjs'),
          'utf8'
        )
      ).toBe(originalComponentMjs);

      // Engine deployed files must be restored
      expect(
        await readFile(
          join(
            projectRoot,
            'engine/toolkit/content/widgets/moz-rollback-widget/moz-rollback-widget.mjs'
          ),
          'utf8'
        )
      ).toBe(originalDeployedMjs);

      // jar.mn must be restored to its original content
      expect(await readFile(join(projectRoot, 'engine/toolkit/content/jar.mn'), 'utf8')).toBe(
        originalJarMn
      );
    });
  });
});
