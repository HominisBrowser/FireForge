// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'linux'),
}));

vi.mock('../../errors/build.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../errors/build.js')>();
  return actual;
});

import type { FireForgeConfig } from '../../types/config.js';
import { pathExists, readText, writeText } from '../../utils/fs.js';
import { BrandingMozconfigMismatchError } from '../branding.js';
import {
  assertBrandingMozconfigAgreement,
  extractWithBrandingPath,
  generateMozconfig,
} from '../mach-mozconfig.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

const config = {
  name: 'TestBrowser',
  vendor: 'TestVendor',
  appId: 'test.browser.id',
  binaryName: 'testbrowser',
} as FireForgeConfig;

/**
 * The preflight verifies both (a) the mozconfig contains a
 * `--with-branding=browser/branding/<binaryName>` directive and (b) the
 * branding tree's `moz.build` exists under `engine/`. The existing tests
 * exercise the generator with minimal templates that do not carry a
 * branding directive; the legacy path through `generateMozconfig` now
 * runs the preflight at the tail, so every happy-path test needs a
 * concrete branding directive in its rendered output AND a `true` return
 * from the branding-tree path probe. These helpers keep that plumbing in
 * one place so the individual tests stay focused on what they actually
 * assert.
 */
const BRANDING_DIRECTIVE = `\nac_add_options --with-branding=browser/branding/${config.binaryName}\n`;

function mockBrandingMozBuildExists(): void {
  // Return true for every pathExists lookup. Each individual test below
  // overrides this where it needs targeted behaviour.
  mockPathExists.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteText.mockResolvedValue(undefined);
});

describe('extractWithBrandingPath', () => {
  it('returns the branding path from a plain directive', () => {
    expect(extractWithBrandingPath('--with-branding=browser/branding/mybrowser\n')).toBe(
      'browser/branding/mybrowser'
    );
  });

  it('handles the `ac_add_options` prefix and leading whitespace', () => {
    expect(
      extractWithBrandingPath('   ac_add_options   --with-branding=browser/branding/mybrowser\n')
    ).toBe('browser/branding/mybrowser');
  });

  it('picks the LAST directive when multiple are present (last-write-wins)', () => {
    const content = [
      '--with-branding=browser/branding/stale',
      '--with-branding=browser/branding/fresh',
    ].join('\n');
    expect(extractWithBrandingPath(content)).toBe('browser/branding/fresh');
  });

  it('returns undefined when no directive is present', () => {
    expect(extractWithBrandingPath('ac_add_options --enable-bootstrap\n')).toBeUndefined();
  });
});

describe('assertBrandingMozconfigAgreement', () => {
  it('passes when the directive names the expected binaryName and the dir exists', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValueOnce(BRANDING_DIRECTIVE);

    await expect(
      assertBrandingMozconfigAgreement('/engine', '/engine/mozconfig', config)
    ).resolves.toBeUndefined();
  });

  it('throws mozconfig-missing-branding when the directive is absent', async () => {
    mockReadText.mockResolvedValueOnce('ac_add_options --enable-bootstrap\n');

    await expect(
      assertBrandingMozconfigAgreement('/engine', '/engine/mozconfig', config)
    ).rejects.toMatchObject({
      reason: 'mozconfig-missing-branding',
    });
  });

  it('throws name-mismatch when binaryName and mozconfig differ', async () => {
    mockReadText.mockResolvedValueOnce(
      'ac_add_options --with-branding=browser/branding/otherbrand\n'
    );

    await expect(
      assertBrandingMozconfigAgreement('/engine', '/engine/mozconfig', config)
    ).rejects.toBeInstanceOf(BrandingMozconfigMismatchError);
    // Reset for second rejection read
    mockReadText.mockResolvedValueOnce(
      'ac_add_options --with-branding=browser/branding/otherbrand\n'
    );
    await expect(
      assertBrandingMozconfigAgreement('/engine', '/engine/mozconfig', config)
    ).rejects.toMatchObject({ reason: 'name-mismatch' });
  });

  it('throws branding-dir-missing when names agree but moz.build is absent', async () => {
    mockReadText.mockResolvedValueOnce(BRANDING_DIRECTIVE);
    mockPathExists.mockResolvedValueOnce(false);

    await expect(
      assertBrandingMozconfigAgreement('/engine', '/engine/mozconfig', config)
    ).rejects.toMatchObject({ reason: 'branding-dir-missing' });
  });

  it('normalises backslash separators in the mozconfig directive before compare', async () => {
    mockReadText.mockResolvedValueOnce(
      `ac_add_options --with-branding=browser\\branding\\${config.binaryName}\n`
    );
    mockPathExists.mockResolvedValue(true);

    await expect(
      assertBrandingMozconfigAgreement('/engine', '/engine/mozconfig', config)
    ).resolves.toBeUndefined();
  });
});

/**
 * Drives readText by routing on path: common.mozconfig / platform.mozconfig
 * templates are served from the caller's strings, and any other path (the
 * preflight re-reads the written mozconfig) echoes back the last
 * `writeText` call's content. Routing on path instead of call-count keeps
 * the helper honest when the generator skips common because
 * `pathExists(common)` returned false.
 */
function stubReadTemplates(common: string, platform: string): void {
  mockReadText.mockImplementation((probedPath: string) => {
    if (probedPath.endsWith('common.mozconfig')) return Promise.resolve(common);
    if (
      probedPath.endsWith('.mozconfig') &&
      !probedPath.endsWith('common.mozconfig') &&
      probedPath.includes('/configs/')
    ) {
      // A platform template (e.g. linux.mozconfig).
      return Promise.resolve(platform);
    }
    // Fallback path — the preflight re-reads the written mozconfig;
    // echo whatever writeText last saw.
    const lastWrite = mockWriteText.mock.calls.at(-1)?.[1];
    return Promise.resolve(lastWrite ?? '');
  });
}

describe('generateMozconfig', () => {
  it('generates mozconfig from common and platform templates', async () => {
    mockBrandingMozBuildExists();
    stubReadTemplates(`COMMON_OPT=\${name}${BRANDING_DIRECTIVE}`, 'PLATFORM_OPT=${vendor}');

    await generateMozconfig('/configs', '/engine', config);

    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/mozconfig',
      expect.stringContaining('COMMON_OPT=TestBrowser')
    );
    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/mozconfig',
      expect.stringContaining('PLATFORM_OPT=TestVendor')
    );
  });

  it('emits --with-distribution-id from the appId prefix ahead of the templates', async () => {
    // Upstream composes the mac bundle id as
    // <distribution-id>.<MOZ_MACBUNDLE_ID>; branding configure.sh carries
    // the leaf, the generated mozconfig must carry the prefix. appId
    // 'test.browser.id' → prefix 'test.browser'.
    mockBrandingMozBuildExists();
    stubReadTemplates(`COMMON_OPT=\${name}${BRANDING_DIRECTIVE}`, 'PLATFORM_OPT=${vendor}');

    await generateMozconfig('/configs', '/engine', config);

    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/mozconfig',
      expect.stringContaining('ac_add_options --with-distribution-id=test.browser\n')
    );
  });

  it('skips common template when it does not exist', async () => {
    mockPathExists.mockImplementation((probedPath: string) => {
      // Common does not exist; platform does; branding moz.build does.
      if (probedPath.endsWith('common.mozconfig')) return Promise.resolve(false);
      return Promise.resolve(true);
    });
    stubReadTemplates('UNUSED_COMMON', `PLATFORM=\${binaryName}${BRANDING_DIRECTIVE}`);

    await generateMozconfig('/configs', '/engine', config);

    const written = mockWriteText.mock.calls[0]?.[1] as string;
    expect(written).not.toContain('Common configuration');
    expect(written).toContain('PLATFORM=testbrowser');
  });

  it('throws when platform template does not exist', async () => {
    mockPathExists
      .mockResolvedValueOnce(true) // common exists
      .mockResolvedValueOnce(false); // platform does not exist

    await expect(generateMozconfig('/configs', '/engine', config)).rejects.toThrow(
      'Platform mozconfig not found'
    );
  });

  it('replaces all template variables', async () => {
    mockBrandingMozBuildExists();
    stubReadTemplates('${name} ${vendor}', `\${appId} \${binaryName}${BRANDING_DIRECTIVE}`);

    await generateMozconfig('/configs', '/engine', config);

    const written = mockWriteText.mock.calls[0]?.[1] as string;
    expect(written).toContain('TestBrowser TestVendor');
    expect(written).toContain('test.browser.id testbrowser');
  });

  it('throws BrandingMozconfigMismatchError when the rendered mozconfig drifts from fireforge.json', async () => {
    mockBrandingMozBuildExists();
    stubReadTemplates(
      'COMMON=1',
      'PLATFORM=1\nac_add_options --with-branding=browser/branding/stalebrand\n'
    );

    await expect(generateMozconfig('/configs', '/engine', config)).rejects.toBeInstanceOf(
      BrandingMozconfigMismatchError
    );
  });
});
