// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addLicenseHeaderToFile,
  containsUpstreamLicenseText,
  getLicenseHeader,
  hasAnyLicenseHeader,
  hasAnyLicenseHeaderAnyStyle,
  hasThirdPartyPermissiveBanner,
  hasUpstreamMplBlockHeader,
} from '../license-headers.js';

vi.mock('../../utils/fs.js', () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));

import { readText, writeText } from '../../utils/fs.js';

const mockReadText = vi.mocked(readText);
const mockWriteText = vi.mocked(writeText);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hasAnyLicenseHeader', () => {
  it('returns true for MPL-2.0 JS header', () => {
    const content =
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
      '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
      'const x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('returns true for EUPL-1.2 JS header', () => {
    const content = '/* SPDX-License-Identifier: EUPL-1.2 */\nconst x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('returns true for 0BSD hash header', () => {
    const content = '# SPDX-License-Identifier: 0BSD\nsome-key = value\n';
    expect(hasAnyLicenseHeader(content, 'hash')).toBe(true);
  });

  it('returns true for MPL-2.0 CSS header', () => {
    const header = getLicenseHeader('MPL-2.0', 'css');
    const content = header + '\n.foo { display: block; }\n';
    expect(hasAnyLicenseHeader(content, 'css')).toBe(true);
  });

  it('returns false for content without any header', () => {
    expect(hasAnyLicenseHeader('const x = 1;\n', 'js')).toBe(false);
  });

  it('returns false for wrong comment style', () => {
    const jsHeader = getLicenseHeader('MPL-2.0', 'js');
    expect(hasAnyLicenseHeader(jsHeader + '\n', 'css')).toBe(false);
  });

  it('tolerates a leading Emacs file-mode block comment before the MPL header', () => {
    const content =
      '/* -*- Mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */\n' +
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
      '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
      'const x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('tolerates Emacs + vim editor directives followed by the canonical block-form MPL header', () => {
    // Mozilla's canonical layout for upstream Firefox source files —
    // editor directives on lines 1–2, license block on lines 3+.
    const cssStyleMpl = getLicenseHeader('MPL-2.0', 'css');
    const content =
      '/* -*- Mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */\n' +
      '/* vim: set ts=8 sts=2 et sw=2 tw=80: */\n' +
      cssStyleMpl +
      '\n\nfunction f() {}\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('returns false when only editor directives are present (no header)', () => {
    const content =
      '/* -*- Mode: javascript -*- */\n' +
      '/* vim: set ts=8 sts=2 et sw=2 tw=80: */\n' +
      'const x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(false);
  });

  it('accepts the older upstream MPL wrap (break after "file,") on js and css styles', () => {
    // Upstream files like ext-browser.js ship the older Mozilla wrap that
    // breaks after "file," instead of "with this" — same wording, only
    // the line-break position differs. Must match on normalized
    // whitespace, not exact wrap.
    const olderWrap =
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n';
    expect(hasAnyLicenseHeader(olderWrap + '"use strict";\n', 'js')).toBe(true);
    expect(hasAnyLicenseHeader(olderWrap + '.x { color: red; }\n', 'css')).toBe(true);
  });

  it('accepts the older MPL wrap in js line-comment form', () => {
    const content =
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      '// You can obtain one at http://mozilla.org/MPL/2.0/.\n' +
      'const x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('accepts the older MPL wrap behind leading editor directives', () => {
    const content =
      '/* -*- Mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */\n' +
      '/* vim: set ts=8 sts=2 et sw=2 tw=80: */\n' +
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n' +
      '"use strict";\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(true);
  });

  it('still rejects near-MPL garbage with altered wording', () => {
    const content =
      '/* This Source Code Form is subject to the terms of the Mozilla Private\n' +
      ' * License, v. 3.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n' +
      'const x = 1;\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(false);
    expect(hasAnyLicenseHeader(content, 'css')).toBe(false);
  });

  it('does not match MPL text that only appears after non-comment code', () => {
    const content =
      'const x = 1;\n' +
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n';
    expect(hasAnyLicenseHeader(content, 'js')).toBe(false);
  });
});

describe('hasUpstreamMplBlockHeader', () => {
  const canonicalWrap =
    '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
    ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
    ' * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n';
  const olderWrap =
    '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
    ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
    ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n';

  it('accepts the canonical block wrap (exact fast path)', () => {
    expect(hasUpstreamMplBlockHeader(canonicalWrap + 'export {};\n')).toBe(true);
  });

  it('accepts the older upstream wrap (break after "file,")', () => {
    expect(hasUpstreamMplBlockHeader(olderWrap + '"use strict";\n')).toBe(true);
  });

  it('accepts both wraps behind a leading editor directive', () => {
    const directive = '/* -*- Mode: javascript; tab-width: 2 -*- */\n';
    expect(hasUpstreamMplBlockHeader(directive + canonicalWrap + 'export {};\n')).toBe(true);
    expect(hasUpstreamMplBlockHeader(directive + olderWrap + 'export {};\n')).toBe(true);
  });

  it('rejects near-MPL garbage with altered wording', () => {
    const garbage =
      '/* This Source Code Form is subject to some of the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n';
    expect(hasUpstreamMplBlockHeader(garbage + 'export {};\n')).toBe(false);
  });

  it('rejects the line-comment MPL form (block form only)', () => {
    const lineForm =
      '// This Source Code Form is subject to the terms of the Mozilla Public\n' +
      '// License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
      '// file, You can obtain one at http://mozilla.org/MPL/2.0/.\n';
    expect(hasUpstreamMplBlockHeader(lineForm + 'const x = 1;\n')).toBe(false);
  });
});

describe('hasAnyLicenseHeaderAnyStyle', () => {
  it('recognizes MPL in CSS block-comment style', () => {
    const content = getLicenseHeader('MPL-2.0', 'css') + '\nbody {}\n';
    expect(hasAnyLicenseHeaderAnyStyle(content)).toBe(true);
  });

  it('recognizes EUPL in hash-comment style', () => {
    const content = getLicenseHeader('EUPL-1.2', 'hash') + '\nkey = value\n';
    expect(hasAnyLicenseHeaderAnyStyle(content)).toBe(true);
  });

  it('returns false when no recognized header is present', () => {
    expect(hasAnyLicenseHeaderAnyStyle('const x = 1;\n')).toBe(false);
  });
});

describe('containsUpstreamLicenseText', () => {
  it('finds Mozilla Public License text in leading lines', () => {
    const content =
      '/* This Source Code Form is subject to the terms of the Mozilla Public License,\n' +
      ' * v. 2.0. */\n' +
      'export class Foo {}\n';
    expect(containsUpstreamLicenseText(content)).toBe(true);
  });

  it('finds SPDX-License-Identifier in leading lines', () => {
    const content =
      '// Copyright 2024 Someone\n' + '// SPDX-License-Identifier: MIT\n' + 'const x = 1;\n';
    expect(containsUpstreamLicenseText(content)).toBe(true);
  });

  it('finds Mozilla MPL wrapped across block-comment continuation lines (Firefox ext-browser shape)', () => {
    const mpl =
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n' +
      '\n' +
      '"use strict";\n';
    const head = mpl.split('\n').slice(0, 6).join('\n');
    expect(head.includes('Mozilla Public License')).toBe(false);
    expect(containsUpstreamLicenseText(mpl)).toBe(true);
  });

  it('finds Mozilla MPL after Emacs and vim editor directive blocks', () => {
    const mpl =
      '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
      ' * License, v. 2.0. If a copy of the MPL was not distributed with this file,\n' +
      ' * You can obtain one at http://mozilla.org/MPL/2.0/. */\n';
    const content =
      '/* -*- Mode: javascript; tab-width: 8; indent-tabs-mode: nil; js-indent-level: 2 -*- */\n' +
      '/* vim: set ts=8 sts=2 et sw=2 tw=80: */\n' +
      mpl +
      'export {};\n';
    expect(containsUpstreamLicenseText(content)).toBe(true);
  });

  it('returns false when no license text in the first 10 lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `// line ${i}`);
    lines[12] = '// Mozilla Public License';
    expect(containsUpstreamLicenseText(lines.join('\n'))).toBe(false);
  });

  it('returns false for content with no license text at all', () => {
    expect(containsUpstreamLicenseText('const x = 1;\nconst y = 2;\n')).toBe(false);
  });
});

describe('hasThirdPartyPermissiveBanner', () => {
  it('recognizes an MIT banner in a JS block comment', () => {
    const content =
      '/**\n' +
      ' * Copyright (c) 2019 The xterm.js authors.\n' +
      ' * Permission is hereby granted, free of charge, to any person obtaining a copy\n' +
      ' */\n';
    expect(hasThirdPartyPermissiveBanner(content)).toBe(true);
  });

  it('recognizes an ISC banner in line comments', () => {
    const content =
      '// ISC License\n// Permission to use, copy, modify, and/or distribute\nconst x = 1;\n';
    expect(hasThirdPartyPermissiveBanner(content)).toBe(true);
  });

  it('recognizes a BSD redistribution clause in hash comments', () => {
    const content =
      '# Redistribution and use in source and binary forms, with or without\n# modification, are permitted\nx = 1\n';
    expect(hasThirdPartyPermissiveBanner(content)).toBe(true);
  });

  it('recognizes an Apache-2.0 banner', () => {
    const content = '// Licensed under the Apache License, Version 2.0\nconst x = 1;\n';
    expect(hasThirdPartyPermissiveBanner(content)).toBe(true);
  });

  it('recognizes bare SPDX identifiers for the permissive set', () => {
    for (const id of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']) {
      expect(hasThirdPartyPermissiveBanner(`// SPDX-License-Identifier: ${id}\n`)).toBe(true);
    }
  });

  it('rejects project headers, MPL headers, and bare code', () => {
    expect(hasThirdPartyPermissiveBanner(getLicenseHeader('EUPL-1.2', 'js') + '\nx;\n')).toBe(
      false
    );
    expect(
      hasThirdPartyPermissiveBanner(
        '/* This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0. */\n'
      )
    ).toBe(false);
    expect(hasThirdPartyPermissiveBanner('const x = 1;\n')).toBe(false);
    expect(hasThirdPartyPermissiveBanner('// SPDX-License-Identifier: GPL-2.0-or-later\n')).toBe(
      false
    );
  });

  it('ignores markers past the scanned head', () => {
    const filler = Array.from({ length: 31 }, (_, i) => `// line ${i}`).join('\n');
    expect(hasThirdPartyPermissiveBanner(`${filler}\n// MIT License\n`)).toBe(false);
  });
});

describe('addLicenseHeaderToFile', () => {
  it('prepends header to file without one', async () => {
    mockReadText.mockResolvedValue('const x = 1;\n');
    mockWriteText.mockResolvedValue(undefined);

    const result = await addLicenseHeaderToFile('/engine/new.js', 'MPL-2.0', 'js');

    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalledWith(
      '/engine/new.js',
      getLicenseHeader('MPL-2.0', 'js') + '\nconst x = 1;\n'
    );
  });

  it('returns false and does not write if header already present', async () => {
    const header = getLicenseHeader('MPL-2.0', 'js');
    mockReadText.mockResolvedValue(header + '\nconst x = 1;\n');

    const result = await addLicenseHeaderToFile('/engine/existing.js', 'MPL-2.0', 'js');

    expect(result).toBe(false);
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
