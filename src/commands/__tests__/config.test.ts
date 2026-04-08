// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  readText,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { configCommand, registerConfig } from '../config.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
}));

import { info, warn } from '../../utils/logger.js';

describe('configCommand', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('sets and gets build.jobs without force', async () => {
    await configCommand(projectRoot, 'build.jobs', '16');
    await configCommand(projectRoot, 'build.jobs');

    const config = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: number };
    };
    expect(config.build?.jobs).toBe(16);
    expect(info).toHaveBeenCalledWith('build.jobs = 16');
  });

  it('sets and gets wire.subscriptDir without force', async () => {
    // String-typed keys are stored as-is (no JSON.parse), so no wrapping quotes needed
    await configCommand(projectRoot, 'wire.subscriptDir', 'browser/components/custom');
    await configCommand(projectRoot, 'wire.subscriptDir');

    const config = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      wire?: { subscriptDir?: string };
    };
    expect(config.wire?.subscriptDir).toBe('browser/components/custom');
    expect(info).toHaveBeenCalledWith('wire.subscriptDir = browser/components/custom');
  });

  it('keeps string-typed Firefox versions as strings without requiring JSON quoting', async () => {
    await configCommand(projectRoot, 'firefox.version', '140.0esr');

    const config = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      firefox?: { version?: string };
    };
    expect(config.firefox?.version).toBe('140.0esr');
  });

  it('warns when JSON parsing would coerce the stored value to a non-string type', async () => {
    await configCommand(projectRoot, 'build.jobs', '16');

    expect(warn).toHaveBeenCalledWith(
      `Value "16" was interpreted as number. Use '"16"' for a string.`
    );
  });

  it('rejects reads for unknown keys', async () => {
    await expect(configCommand(projectRoot, 'firefox.channel')).rejects.toThrow(
      'Unknown config key: firefox.channel'
    );
  });

  it('fails cleanly when no project config exists', async () => {
    await removeTempProject(projectRoot);
    projectRoot = await createTempProject();

    await expect(configCommand(projectRoot, 'build.jobs')).rejects.toThrow(
      'No fireforge.json found. Run "fireforge setup" to create a project.'
    );
  });

  it('rejects unknown top-level keys without force', async () => {
    await expect(configCommand(projectRoot, 'custom.key', '1')).rejects.toThrow(
      'Unknown config key prefix: "custom"'
    );
  });

  it('rejects unknown nested keys without force', async () => {
    await expect(configCommand(projectRoot, 'firefox.channel', '"nightly"')).rejects.toThrow(
      'Unknown config key: "firefox.channel"'
    );
  });

  it('rejects invalid values for known keys without force', async () => {
    await expect(configCommand(projectRoot, 'build.jobs', '"oops"')).rejects.toThrow(
      'Invalid value for "build.jobs"'
    );
  });

  it('accepts unknown top-level keys with force', async () => {
    await configCommand(projectRoot, 'custom.key', '1', { force: true });

    const config = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      custom?: { key?: number };
    };
    expect(config.custom?.key).toBe(1);
  });

  it('accepts invalid known-key structures with force', async () => {
    await configCommand(projectRoot, 'build.jobs', '"oops"', { force: true });

    const config = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: string };
    };
    expect(config.build?.jobs).toBe('oops');
  });
});

describe('registerConfig', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('routes parsed CLI arguments through the registered action', async () => {
    const program = new Command();

    registerConfig(program, {
      getProjectRoot: () => projectRoot,
      withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
    });

    await program.parseAsync(['node', 'test', 'config', 'build.jobs', '12']);
    await program.parseAsync(['node', 'test', 'config', 'build.jobs']);

    const config = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: number };
    };
    expect(config.build?.jobs).toBe(12);
    expect(info).toHaveBeenCalledWith('build.jobs = 12');
  });
});
