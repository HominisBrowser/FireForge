// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../test-stale-exempt.js', () => ({ loadEngineInstallIndex: vi.fn() }));
vi.mock('../objdir-install-manifests.js', () => ({ classifyRuntimeDelivery: vi.fn() }));

import {
  findCompiledControlTargets,
  formatCompiledControlRefusal,
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

describe('formatCompiledControlRefusal', () => {
  it('names the files, the --build remedy and the manual procedure', () => {
    const message = formatCompiledControlRefusal(['gfx/a.cpp']);
    expect(message).toContain('engine/gfx/a.cpp');
    expect(message).toContain('Add --build');
    expect(message).toContain('`touch` it');
  });
});
