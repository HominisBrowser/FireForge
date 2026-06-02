// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  readProjectText,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { sourceSetCommand } from '../source.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

describe('sourceSetCommand', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('atomically writes version, product, and normalized sha256', async () => {
    await sourceSetCommand(projectRoot, {
      version: '152.0b6',
      product: 'firefox-devedition',
      sha256: 'A'.repeat(64),
    });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox: { version: string; product: string; sha256?: string };
    };
    expect(config.firefox).toEqual({
      version: '152.0b6',
      product: 'firefox-devedition',
      sha256: 'a'.repeat(64),
    });
  });

  it('clears sha256 when requested', async () => {
    await sourceSetCommand(projectRoot, {
      version: '152.0b6',
      product: 'firefox-beta',
      sha256: 'b'.repeat(64),
    });

    await sourceSetCommand(projectRoot, {
      version: '152.0b6',
      product: 'firefox-devedition',
      clearSha256: true,
    });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox: { sha256?: string };
    };
    expect(config.firefox.sha256).toBeUndefined();
  });

  it('leaves the config unchanged when the final tuple is invalid', async () => {
    const before = await readProjectText(projectRoot, 'fireforge.json');

    await expect(
      sourceSetCommand(projectRoot, {
        version: '152.0',
        product: 'firefox-devedition',
      })
    ).rejects.toThrow('requires a beta version');

    await expect(readProjectText(projectRoot, 'fireforge.json')).resolves.toBe(before);
  });
});
