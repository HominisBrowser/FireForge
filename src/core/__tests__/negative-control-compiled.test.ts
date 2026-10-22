// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../test-stale-exempt.js', () => ({ loadEngineInstallIndex: vi.fn() }));
vi.mock('../objdir-install-manifests.js', () => ({ classifyRuntimeDelivery: vi.fn() }));

import {
  findCompiledControlTargets,
  formatCompiledControlRefusal,
  isCompiledSourcePath,
} from '../negative-control-compiled.js';
import { classifyRuntimeDelivery } from '../objdir-install-manifests.js';
import { loadEngineInstallIndex } from '../test-stale-exempt.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findCompiledControlTargets', () => {
  it('skips the manifest probe when no target has a compiled-source extension', async () => {
    await expect(findCompiledControlTargets('/engine', ['a.sys.mjs', 'b.css'])).resolves.toEqual(
      []
    );
    expect(loadEngineInstallIndex).not.toHaveBeenCalled();
  });

  it('treats every compiled-looking target as compiled without an install index', async () => {
    vi.mocked(loadEngineInstallIndex).mockResolvedValueOnce(undefined);
    await expect(findCompiledControlTargets('/engine', ['x.cpp', 'y.js'])).resolves.toEqual([
      'x.cpp',
    ]);
  });

  it('keeps only the targets no install manifest ships', async () => {
    vi.mocked(loadEngineInstallIndex).mockResolvedValueOnce({} as never);
    vi.mocked(classifyRuntimeDelivery).mockImplementation((_index, _engine, path) =>
      Promise.resolve(path === 'shipped.yaml' ? 'packaged' : 'unlisted')
    );
    await expect(
      findCompiledControlTargets('/engine', ['gfx/a.cpp', 'shipped.yaml', 'dom/b.webidl'])
    ).resolves.toEqual(['gfx/a.cpp', 'dom/b.webidl']);
  });
});

describe('exported headers', () => {
  it('treats a header an install manifest exports as compiled', async () => {
    vi.mocked(loadEngineInstallIndex).mockResolvedValueOnce({} as never);
    vi.mocked(classifyRuntimeDelivery).mockResolvedValue('packaged');
    await expect(
      findCompiledControlTargets('/engine', [
        'docshell/base/BrowsingContext.h',
        'ipc/x.ipdlh',
        'shipped.yaml',
      ])
    ).resolves.toEqual(['docshell/base/BrowsingContext.h', 'ipc/x.ipdlh']);
  });

  it('skips the manifest probe when every target is a header', async () => {
    await expect(findCompiledControlTargets('/engine', ['a.hpp', 'b.hh'])).resolves.toEqual([
      'a.hpp',
      'b.hh',
    ]);
    expect(loadEngineInstallIndex).not.toHaveBeenCalled();
  });
});

describe('isCompiledSourcePath', () => {
  it('matches compiled extensions only', () => {
    expect(isCompiledSourcePath('gfx/a.cpp')).toBe(true);
    expect(isCompiledSourcePath('modules/libpref/init/StaticPrefList.yaml')).toBe(true);
    expect(isCompiledSourcePath('browser/a.sys.mjs')).toBe(false);
  });
});

describe('formatCompiledControlRefusal', () => {
  it('names the files, the --build remedy and the manual procedure', () => {
    const message = formatCompiledControlRefusal(['gfx/a.cpp']);
    expect(message).toContain('engine/gfx/a.cpp');
    expect(message).toContain('Add --build');
    expect(message).toContain('`touch` it');
  });
});
