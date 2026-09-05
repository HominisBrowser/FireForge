// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';
import { isBrandingSetup, setupBranding, splitAppId } from '../branding.js';

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { nativePath } from '../../test-utils/index.js';
import { pathExists, readText, writeTextIfChanged } from '../../utils/fs.js';

const config = {
  name: 'MyBrowser',
  vendor: 'My Company',
  appId: 'org.example.mybrowser',
  binaryName: 'mybrowser',
};

describe('isBrandingSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when all generated branding files and moz.configure match the config', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('configure.sh')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME="MyBrowser"
MOZ_MACBUNDLE_ID="mybrowser"
`);
      }
      if (filePath.endsWith('brand.properties')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

brandShorterName=MyBrowser
brandShortName=MyBrowser
brandFullName=MyBrowser
`);
      }
      if (filePath.endsWith('brand.ftl')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Brand names
##
## These brand names can be used in messages.

-brand-shorter-name = MyBrowser
-brand-short-name = MyBrowser
-brand-shortcut-name = MyBrowser
-brand-full-name = MyBrowser
-brand-product-name = MyBrowser
-vendor-short-name = My Company
trademarkInfo = { " " }
`);
      }
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      return Promise.resolve('imply_option("MOZ_APP_VENDOR", "My Company")\n');
    });

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(true);
  });

  it('returns false when configure.sh is stale', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath.endsWith('configure.sh'))
    );
    vi.mocked(readText).mockResolvedValue(
      'MOZ_APP_DISPLAYNAME="OldBrowser"\nMOZ_MACBUNDLE_ID="mybrowser"\n'
    );

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(false);
  });

  it('returns true when configure.sh has extra patch-owned branding settings', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath.endsWith('configure.sh'))
    );
    vi.mocked(readText).mockResolvedValue(
      [
        'MOZ_APP_DISPLAYNAME="MyBrowser"',
        'MOZ_APP_VENDOR="My Company"',
        'MOZ_MACBUNDLE_ID="mybrowser"',
        'MOZ_APP_REMOTINGNAME=hominis-dev',
        'MOZ_DEV_EDITION=1',
        '',
      ].join('\n')
    );

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(true);
  });

  it('returns true when legacy moz.configure vendor is absent but generated branding has vendor', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        filePath.endsWith('configure.sh') ||
          filePath.endsWith('brand.properties') ||
          filePath.endsWith('brand.ftl') ||
          filePath.endsWith(nativePath('/browser/moz.configure'))
      )
    );
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('configure.sh')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME="MyBrowser"
MOZ_APP_VENDOR="My Company"
MOZ_MACBUNDLE_ID="mybrowser"
`);
      }
      if (filePath.endsWith('brand.properties')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

brandShorterName=MyBrowser
brandShortName=MyBrowser
brandFullName=MyBrowser
`);
      }
      if (filePath.endsWith('brand.ftl')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Brand names
##
## These brand names can be used in messages.

-brand-shorter-name = MyBrowser
-brand-short-name = MyBrowser
-brand-shortcut-name = MyBrowser
-brand-full-name = MyBrowser
-brand-product-name = MyBrowser
-vendor-short-name = My Company
trademarkInfo = { " " }
`);
      }
      return Promise.resolve('# no process-wide vendor line\n');
    });

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(true);
  });

  it('returns false when ESR-style branding configure.sh still carries MOZ_APP_VENDOR', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('configure.sh')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME="MyBrowser"
MOZ_APP_VENDOR="My Company"
MOZ_MACBUNDLE_ID="mybrowser"
`);
      }
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      return Promise.resolve('imply_option("MOZ_APP_VENDOR", "My Company")\n');
    });

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(false);
  });
});

describe('setupBranding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips writes when branding files already match the config', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      if (filePath.endsWith('moz.configure')) {
        return Promise.resolve(
          'some preamble\nimply_option("MOZ_APP_VENDOR", "My Company")\nsome trailer\n'
        );
      }
      return Promise.resolve('');
    });
    vi.mocked(writeTextIfChanged).mockResolvedValue(false);

    await setupBranding('/engine', config);

    for (const call of vi.mocked(writeTextIfChanged).mock.calls) {
      expect(call[0]).toBeDefined();
    }
    expect(vi.mocked(writeTextIfChanged)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(writeTextIfChanged).mock.calls[0]?.[1]).not.toContain('MOZ_APP_VENDOR=');
  });

  it('writes all files and keeps vendor in moz.configure on ESR-style trees', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) => {
      if (filePath.endsWith('unofficial')) return Promise.resolve(true);
      if (filePath.endsWith('mybrowser')) return Promise.resolve(false);
      if (filePath.endsWith('brand.properties')) return Promise.resolve(true);
      if (filePath.endsWith('brand.ftl')) return Promise.resolve(true);
      if (filePath.endsWith('moz.configure')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      if (filePath.endsWith('moz.configure')) {
        return Promise.resolve('imply_option("MOZ_APP_VENDOR", "Mozilla")\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(writeTextIfChanged).mockResolvedValue(true);

    await setupBranding('/engine', config);

    const calls = vi.mocked(writeTextIfChanged).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[0]).toContain('configure.sh');
    expect(calls[0]?.[1]).not.toContain('MOZ_APP_VENDOR=');
    expect(calls[3]?.[0]).toContain('moz.configure');
    expect(calls[3]?.[1]).toContain('imply_option("MOZ_APP_VENDOR", "My Company")');
  });

  it('inserts the browser moz.configure vendor line when a project_flag tree omits it', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) => {
      if (filePath.endsWith('unofficial')) return Promise.resolve(true);
      if (filePath.endsWith('mybrowser')) return Promise.resolve(false);
      if (filePath.endsWith('brand.properties')) return Promise.resolve(true);
      if (filePath.endsWith('brand.ftl')) return Promise.resolve(true);
      if (filePath.endsWith('moz.configure')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      if (filePath.endsWith('moz.configure')) {
        return Promise.resolve(
          '# configure without vendor imply option\ninclude("../toolkit/moz.configure")\n'
        );
      }
      return Promise.resolve('');
    });
    vi.mocked(writeTextIfChanged).mockResolvedValue(true);

    await expect(setupBranding('/engine', config)).resolves.toBeUndefined();

    const calls = vi.mocked(writeTextIfChanged).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[0]).toContain('configure.sh');
    expect(calls[0]?.[1]).not.toContain('MOZ_APP_VENDOR=');
    expect(calls[3]?.[0]).toContain('moz.configure');
    expect(calls[3]?.[1]).toContain('imply_option("MOZ_APP_VENDOR", "My Company")');
    expect(calls[3]?.[1]).toContain('include("../toolkit/moz.configure")');
  });

  it('falls back to generated branding vendor when moz.configure has no project_flag contract', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) => {
      if (filePath.endsWith('unofficial')) return Promise.resolve(true);
      if (filePath.endsWith('mybrowser')) return Promise.resolve(false);
      if (filePath.endsWith('brand.properties')) return Promise.resolve(true);
      if (filePath.endsWith('brand.ftl')) return Promise.resolve(true);
      if (filePath.endsWith(nativePath('/browser/moz.configure'))) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith(nativePath('/browser/moz.configure'))) {
        return Promise.resolve('# configure without vendor imply option\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(writeTextIfChanged).mockResolvedValue(true);

    await expect(setupBranding('/engine', config)).resolves.toBeUndefined();

    const calls = vi.mocked(writeTextIfChanged).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[0]).toContain('configure.sh');
    expect(calls[0]?.[1]).toContain('MOZ_APP_VENDOR="My Company"');
    expect(calls.some((call) => call[0].endsWith('moz.configure'))).toBe(false);
  });

  it('stamps generated files with the project license header', async () => {
    // Regression: without a license in BrandingConfig, the scaffold wrote
    // MPL-2.0 headers unconditionally. `patch-lint` then flagged every
    // generated branding file for `missing-license-header` on the first
    // export of a non-MPL project (0BSD, EUPL-1.2, GPL-2.0-or-later).
    vi.mocked(pathExists).mockImplementation((filePath: string) => {
      if (filePath.endsWith('unofficial')) return Promise.resolve(true);
      if (filePath.endsWith('mybrowser')) return Promise.resolve(false);
      if (filePath.endsWith('brand.properties')) return Promise.resolve(true);
      if (filePath.endsWith('brand.ftl')) return Promise.resolve(true);
      if (filePath.endsWith('moz.configure')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      if (filePath.endsWith('moz.configure')) {
        return Promise.resolve('imply_option("MOZ_APP_VENDOR", "Mozilla")\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(writeTextIfChanged).mockResolvedValue(true);

    await setupBranding('/engine', { ...config, license: '0BSD' });

    const calls = vi.mocked(writeTextIfChanged).mock.calls;
    // configure.sh, brand.properties and brand.ftl must all carry the
    // `# SPDX-License-Identifier: 0BSD` header (hash-style comments for all
    // three file types).
    expect(calls[0]?.[1]).toContain('# SPDX-License-Identifier: 0BSD');
    expect(calls[1]?.[1]).toContain('# SPDX-License-Identifier: 0BSD');
    expect(calls[2]?.[1]).toContain('# SPDX-License-Identifier: 0BSD');
    // moz.configure patching (call 3) never rewrites the license, which is
    // upstream-owned.
    expect(calls[3]?.[1]).not.toContain('SPDX-License-Identifier: 0BSD');
  });

  it('preserves patch-owned configure.sh settings while refreshing managed branding keys', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) => {
      if (filePath.endsWith('unofficial')) return Promise.resolve(true);
      if (filePath.endsWith('mybrowser')) return Promise.resolve(true);
      if (filePath.endsWith('configure.sh')) return Promise.resolve(true);
      if (filePath.endsWith('brand.properties')) return Promise.resolve(false);
      if (filePath.endsWith('brand.ftl')) return Promise.resolve(false);
      if (filePath.endsWith(nativePath('/browser/moz.configure'))) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('configure.sh')) {
        return Promise.resolve(
          [
            'MOZ_APP_DISPLAYNAME="OldBrowser"',
            'MOZ_MACBUNDLE_ID="old.bundle"',
            'MOZ_APP_REMOTINGNAME=hominis-dev',
            'MOZ_DEV_EDITION=1',
            '',
          ].join('\n')
        );
      }
      if (filePath.includes(nativePath('/toolkit/moz.configure'))) {
        return Promise.resolve(`
project_flag(
    env="MOZ_APP_VENDOR",
    nargs=1,
    help="Application vendor",
)
`);
      }
      if (filePath.endsWith(nativePath('/browser/moz.configure'))) {
        return Promise.resolve('imply_option("MOZ_APP_VENDOR", "My Company")\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(writeTextIfChanged).mockResolvedValue(true);

    await setupBranding('/engine', config);

    const configureCall = vi
      .mocked(writeTextIfChanged)
      .mock.calls.find((call) => call[0].endsWith('configure.sh'));
    expect(configureCall?.[1]).toContain('MOZ_APP_DISPLAYNAME="MyBrowser"');
    expect(configureCall?.[1]).toContain('MOZ_MACBUNDLE_ID="mybrowser"');
    expect(configureCall?.[1]).toContain('MOZ_APP_REMOTINGNAME=hominis-dev');
    expect(configureCall?.[1]).toContain('MOZ_DEV_EDITION=1');
    expect(configureCall?.[1]).not.toContain('OldBrowser');
    expect(configureCall?.[1]).not.toContain('old.bundle');
  });
});

describe('splitAppId', () => {
  it('splits a reverse-domain appId into distribution id and leaf', () => {
    expect(splitAppId('org.example.mybrowser')).toEqual({
      distributionId: 'org.example',
      leaf: 'mybrowser',
    });
    expect(splitAppId('org.hominis.browser')).toEqual({
      distributionId: 'org.hominis',
      leaf: 'browser',
    });
  });
});

describe('doubled-bundle-id regression', () => {
  // Upstream composes the bundle id as <distribution-id>.<MOZ_MACBUNDLE_ID>.
  // A configure.sh carrying the full appId is exactly the bug that shipped
  // org.mozilla.org.hominis.browser. Such content must read as stale so
  // setupBranding rewrites it to the leaf.
  it('treats a configure.sh carrying the full appId as stale', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath.endsWith('configure.sh'))
    );
    vi.mocked(readText).mockResolvedValue(
      'MOZ_APP_DISPLAYNAME="MyBrowser"\nMOZ_MACBUNDLE_ID="org.example.mybrowser"\n'
    );

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(false);
  });
});
