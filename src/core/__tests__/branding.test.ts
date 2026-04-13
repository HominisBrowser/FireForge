// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isBrandingSetup, setupBranding } from '../branding.js';

vi.mock('../../utils/fs.js', () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  writeTextIfChanged: vi.fn(),
  pathExists: vi.fn(),
  copyDir: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

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

  it('returns true when all generated branding files match the config', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('configure.sh')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME="MyBrowser"
MOZ_MACBUNDLE_ID="org.example.mybrowser"
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
      return Promise.resolve('imply_option("MOZ_APP_VENDOR", "My Company")\n');
    });

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(true);
  });

  it('returns false when configure.sh is stale', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath.endsWith('configure.sh'))
    );
    vi.mocked(readText).mockResolvedValue(
      'MOZ_APP_DISPLAYNAME="OldBrowser"\nMOZ_MACBUNDLE_ID="org.example.mybrowser"\n'
    );

    await expect(isBrandingSetup('/engine', config)).resolves.toBe(false);
  });

  it('returns false when moz.configure vendor is stale', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        filePath.endsWith('configure.sh') ||
          filePath.endsWith('brand.properties') ||
          filePath.endsWith('brand.ftl') ||
          filePath.endsWith('moz.configure')
      )
    );
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('configure.sh')) {
        return Promise.resolve(`# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME="MyBrowser"
MOZ_MACBUNDLE_ID="org.example.mybrowser"
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
      return Promise.resolve('imply_option("MOZ_APP_VENDOR", "Old Vendor")\n');
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
  });

  it('writes all files when branding directory and locale files exist', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) => {
      if (filePath.endsWith('unofficial')) return Promise.resolve(true);
      if (filePath.endsWith('mybrowser')) return Promise.resolve(false);
      if (filePath.endsWith('brand.properties')) return Promise.resolve(true);
      if (filePath.endsWith('brand.ftl')) return Promise.resolve(true);
      if (filePath.endsWith('moz.configure')) return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(readText).mockImplementation((filePath: string) => {
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
    expect(calls[3]?.[0]).toContain('moz.configure');
  });
});
