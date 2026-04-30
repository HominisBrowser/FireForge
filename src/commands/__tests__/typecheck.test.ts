// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
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
  loadConfig: vi.fn(),
}));

vi.mock('../../core/typecheck.js', () => ({
  runTypecheck: vi.fn(),
  // The CLI imports relativeForDisplay; pass-through implementation
  // covers the unit assertions below.
  relativeForDisplay: (_root: string, file: string) => file,
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  verbose: vi.fn(),
}));

import { loadConfig } from '../../core/config.js';
import { runTypecheck } from '../../core/typecheck.js';
import { GeneralError } from '../../errors/base.js';
import type { TypecheckProjectResult } from '../../types/typecheck.js';
import { warn } from '../../utils/logger.js';
import { reportResults, resolveTypecheckProjects, typecheckCommand } from '../typecheck.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockRunTypecheck = vi.mocked(runTypecheck);
const mockWarn = vi.mocked(warn);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTypecheckProjects', () => {
  it('returns the configured block when no override is given', () => {
    expect(
      resolveTypecheckProjects(
        { projects: ['a/jsconfig.json', 'b/jsconfig.json'], extraShim: 'extras.d.ts' },
        undefined
      )
    ).toEqual({ projects: ['a/jsconfig.json', 'b/jsconfig.json'], extraShim: 'extras.d.ts' });
  });

  it('replaces projects with --project but preserves the configured extraShim', () => {
    expect(
      resolveTypecheckProjects(
        { projects: ['a/jsconfig.json', 'b/jsconfig.json'], extraShim: 'extras.d.ts' },
        'one-off/jsconfig.json'
      )
    ).toEqual({ projects: ['one-off/jsconfig.json'], extraShim: 'extras.d.ts' });
  });

  it('accepts --project even when no typecheck block is configured', () => {
    expect(resolveTypecheckProjects(undefined, 'one-off/jsconfig.json')).toEqual({
      projects: ['one-off/jsconfig.json'],
    });
  });

  it('throws a clear error when neither config nor --project is set', () => {
    expect(() => resolveTypecheckProjects(undefined, undefined)).toThrow(
      /No typecheck configuration found/
    );
  });

  it('rejects an empty --project string', () => {
    expect(() => resolveTypecheckProjects({ projects: ['a/jsconfig.json'] }, '')).toThrow(
      '--project requires a non-empty path'
    );
  });
});

describe('reportResults', () => {
  it('passes silently when no issues are reported', () => {
    expect(() => {
      reportResults('/project', [{ project: 'a/jsconfig.json', issues: [], filesChecked: 5 }]);
    }).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('throws GeneralError on errors and prints every issue', () => {
    const results: TypecheckProjectResult[] = [
      {
        project: 'a/jsconfig.json',
        filesChecked: 1,
        issues: [
          {
            file: '/project/a/mod.mjs',
            line: 3,
            column: 14,
            code: 2322,
            category: 'error',
            message: "Type 'string' is not assignable to type 'number'.",
            project: 'a/jsconfig.json',
          },
          {
            file: '/project/a/mod.mjs',
            line: 5,
            column: 1,
            code: 6133,
            category: 'warning',
            message: "'unused' is declared but its value is never read.",
            project: 'a/jsconfig.json',
          },
        ],
      },
    ];
    expect(() => {
      reportResults('/project', results);
    }).toThrow(GeneralError);
    // One warning for the warning, one for the error → two warn() calls.
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('passes with warnings only (no errors → no throw)', () => {
    const results: TypecheckProjectResult[] = [
      {
        project: 'a/jsconfig.json',
        filesChecked: 1,
        issues: [
          {
            file: '/project/a/mod.mjs',
            line: 1,
            column: 1,
            code: 6133,
            category: 'warning',
            message: 'something',
            project: 'a/jsconfig.json',
          },
        ],
      },
    ];
    expect(() => {
      reportResults('/project', results);
    }).not.toThrow();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('typecheckCommand', () => {
  it('rejects when fireforge.json has no typecheck block and no --project is given', async () => {
    mockLoadConfig.mockResolvedValue({
      name: 'p',
      vendor: 'v',
      appId: 'org.v.p',
      binaryName: 'p',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    await expect(typecheckCommand('/project', {})).rejects.toThrow(
      /No typecheck configuration found/
    );
  });

  it('runs the configured projects and exits non-zero on errors', async () => {
    mockLoadConfig.mockResolvedValue({
      name: 'p',
      vendor: 'v',
      appId: 'org.v.p',
      binaryName: 'p',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      typecheck: { projects: ['a/jsconfig.json'] },
    });
    mockRunTypecheck.mockResolvedValue([
      {
        project: 'a/jsconfig.json',
        filesChecked: 1,
        issues: [
          {
            file: '/project/a/mod.mjs',
            line: 1,
            column: 1,
            code: 2322,
            category: 'error',
            message: 'bad',
            project: 'a/jsconfig.json',
          },
        ],
      },
    ]);
    await expect(typecheckCommand('/project', {})).rejects.toThrow(GeneralError);
    expect(mockRunTypecheck).toHaveBeenCalledWith('/project', { projects: ['a/jsconfig.json'] });
  });

  it('honours --project for one-off runs even when config has no typecheck block', async () => {
    mockLoadConfig.mockResolvedValue({
      name: 'p',
      vendor: 'v',
      appId: 'org.v.p',
      binaryName: 'p',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    });
    mockRunTypecheck.mockResolvedValue([
      { project: 'oneoff/jsconfig.json', filesChecked: 0, issues: [] },
    ]);
    await typecheckCommand('/project', { project: 'oneoff/jsconfig.json' });
    expect(mockRunTypecheck).toHaveBeenCalledWith('/project', {
      projects: ['oneoff/jsconfig.json'],
    });
  });
});
