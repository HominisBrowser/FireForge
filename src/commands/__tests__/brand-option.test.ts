// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
      license: 'EUPL-1.2',
      build: { jobs: 8 },
    })
  ),
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../../core/mach.js', () => ({
  generateMozconfig: vi.fn(() => Promise.resolve()),
  build: vi.fn(() => Promise.resolve(0)),
  buildUI: vi.fn(() => Promise.resolve(0)),
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
  buildArtifactMismatchMessage: vi.fn(() => undefined),
  machPackage: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../../core/branding.js', () => ({
  isBrandingSetup: vi.fn(() => Promise.resolve(true)),
  setupBranding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/furnace-stories.js', () => ({
  cleanStories: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      overrides: {},
      custom: {},
    })
  ),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

import { build, buildUI, generateMozconfig, machPackage } from '../../core/mach.js';
import { buildCommand } from '../build.js';
import { packageCommand } from '../package.js';

describe('brand override handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unsupported build brand overrides before mutating the workspace', async () => {
    await expect(buildCommand('/project', { brand: 'dev' })).rejects.toThrow(
      /Brand override "dev" is not supported yet/i
    );
    expect(generateMozconfig).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(buildUI).not.toHaveBeenCalled();
  });

  it('rejects unsupported package brand overrides before mutating the workspace', async () => {
    await expect(packageCommand('/project', { brand: 'stable' })).rejects.toThrow(
      /Brand override "stable" is not supported yet/i
    );
    expect(generateMozconfig).not.toHaveBeenCalled();
    expect(machPackage).not.toHaveBeenCalled();
  });

  it('allows the configured brand name as a no-op alias', async () => {
    await expect(buildCommand('/project', { brand: 'mybrowser' })).resolves.toBeUndefined();
    await expect(packageCommand('/project', { brand: 'mybrowser' })).resolves.toBeUndefined();
    expect(generateMozconfig).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(1);
    expect(machPackage).toHaveBeenCalledTimes(1);
  });
});
