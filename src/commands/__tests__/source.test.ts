// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../cli.js';
import {
  createTempProject,
  readProjectText,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { success } from '../../utils/logger.js';
import { sourceSetCommand } from '../source.js';

vi.mock('../../utils/logger.js', async () => {
  // Imported inside the factory: `vi.mock` is hoisted above the
  // import block, so a top-level binding is not yet initialised here.
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});

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
    expect(success).toHaveBeenCalledWith(
      'Resolved source URL: https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );
  });

  it('edits the firefox keys in place and keeps the rest of the file byte for byte', async () => {
    const compact = [
      '{',
      '  "name": "Test Browser", "vendor": "Test", "appId": "org.test.browser",',
      '  "binaryName": "testbrowser",',
      '  "firefox": { "version": "140.0esr", "product": "firefox-esr" },',
      '  "patchLint": { "rawColorAllowlist": ["a.css", "b.css"] }',
      '}',
      '',
    ].join('\n');
    await writeFiles(projectRoot, { 'fireforge.json': compact });

    await sourceSetCommand(projectRoot, {
      version: '140.1.0esr',
      product: 'firefox-esr',
      sha256: 'c'.repeat(64),
    });

    expect(await readProjectText(projectRoot, 'fireforge.json')).toBe(
      compact.replace(
        '{ "version": "140.0esr", "product": "firefox-esr" }',
        `{ "version": "140.1.0esr", "product": "firefox-esr", "sha256": "${'c'.repeat(64)}" }`
      )
    );
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

  it('persists a release candidate and echoes the candidates URL', async () => {
    await sourceSetCommand(projectRoot, {
      version: '152.0b6',
      product: 'firefox-devedition',
      candidate: 'build2',
    });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox: { version: string; product: string; candidate?: string };
    };
    expect(config.firefox.candidate).toBe('build2');
    expect(success).toHaveBeenCalledWith('Set firefox.candidate = build2');
    expect(success).toHaveBeenCalledWith(
      'Resolved source URL: https://archive.mozilla.org/pub/devedition/candidates/152.0b6-candidates/build2/source/firefox-152.0b6.source.tar.xz'
    );
  });

  it('clears the candidate when requested', async () => {
    await sourceSetCommand(projectRoot, {
      version: '152.0b6',
      product: 'firefox-devedition',
      candidate: 'build2',
    });

    await sourceSetCommand(projectRoot, {
      version: '152.0b6',
      product: 'firefox-devedition',
      clearCandidate: true,
    });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox: { candidate?: string };
    };
    expect(config.firefox.candidate).toBeUndefined();
    expect(success).toHaveBeenCalledWith(
      'Resolved source URL: https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );
  });

  it('rejects --candidate combined with --clear-candidate', async () => {
    await expect(
      sourceSetCommand(projectRoot, {
        version: '152.0b6',
        product: 'firefox-devedition',
        candidate: 'build2',
        clearCandidate: true,
      })
    ).rejects.toThrow('--candidate cannot be combined with --clear-candidate');
  });

  it('rejects a malformed --candidate value at the CLI boundary', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => undefined });

    try {
      await expect(
        program.parseAsync(
          [
            'source',
            'set',
            '--version',
            '152.0b6',
            '--product',
            'firefox-devedition',
            '--candidate',
            'buildx',
          ],
          { from: 'user' }
        )
      ).rejects.toThrow('--candidate must look like "buildN" (e.g. "build2"), got "buildx"');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('parses source set --version in space form without invoking the root CLI version', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    const program = createProgram();
    program.exitOverride();

    try {
      await program.parseAsync(
        [
          'source',
          'set',
          '--version',
          '152.0b6',
          '--product',
          'firefox-devedition',
          '--sha256',
          '7c56149a36380cf5ee39c2423216303c92fd8a56a160f387708e3764207162ad',
        ],
        { from: 'user' }
      );
    } finally {
      cwdSpy.mockRestore();
    }

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox: { version: string; product: string; sha256?: string };
    };
    expect(config.firefox).toEqual({
      version: '152.0b6',
      product: 'firefox-devedition',
      sha256: '7c56149a36380cf5ee39c2423216303c92fd8a56a160f387708e3764207162ad',
    });
  });

  it('parses source set --version=... equals form', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    const program = createProgram();
    program.exitOverride();

    try {
      await program.parseAsync(
        [
          'source',
          'set',
          '--version=152.0b6',
          '--product=firefox-devedition',
          '--sha256=7c56149a36380cf5ee39c2423216303c92fd8a56a160f387708e3764207162ad',
        ],
        { from: 'user' }
      );
    } finally {
      cwdSpy.mockRestore();
    }

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox: { version: string; product: string; sha256?: string };
    };
    expect(config.firefox.version).toBe('152.0b6');
    expect(config.firefox.product).toBe('firefox-devedition');
    expect(config.firefox.sha256).toBe(
      '7c56149a36380cf5ee39c2423216303c92fd8a56a160f387708e3764207162ad'
    );
  });
});
