// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDir, writeText } from '../../utils/fs.js';
import * as platform from '../../utils/platform.js';
import { detectPlatformGate, findEnclosingGate } from '../build-audit-platform.js';

describe('findEnclosingGate', () => {
  it('returns the if-CONFIG expression when the basename appears inside that block', () => {
    const moz = `
DIRS += [
    "shared",
]

if CONFIG["MAKENSISU"]:
    BRANDING_FILES += [
        "stubinstaller/installing_page.css",
        "stubinstaller/profile_cleanup_page.css",
    ]
`;
    expect(findEnclosingGate(moz, 'installing_page.css')).toContain('MAKENSISU');
  });

  it('returns undefined for a top-level entry not inside any block', () => {
    const moz = `
BRANDING_FILES += [
    "branding.png",
    "icon.png",
]
`;
    expect(findEnclosingGate(moz, 'branding.png')).toBeUndefined();
  });

  it('handles nested if blocks and returns the innermost gate', () => {
    const moz = `
if CONFIG["OS_TARGET"] == "WINNT":
    if CONFIG["MAKENSISU"]:
        BRANDING_FILES += [
            "win/stub.css",
        ]
`;
    const gate = findEnclosingGate(moz, 'stub.css');
    expect(gate).toContain('MAKENSISU');
  });

  it('does not match a basename mentioned outside an if block', () => {
    const moz = `
BRANDING_FILES += [
    "always.png",
]

if CONFIG["MAKENSISU"]:
    BRANDING_FILES += [
        "windows-only.png",
    ]
`;
    expect(findEnclosingGate(moz, 'always.png')).toBeUndefined();
    expect(findEnclosingGate(moz, 'windows-only.png')).toContain('MAKENSISU');
  });
});

describe('detectPlatformGate', () => {
  let engineDir: string;
  beforeEach(async () => {
    engineDir = await mkdtemp(join(tmpdir(), 'ff-platgate-'));
  });
  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports gatedOff for a Windows-only file on a non-Windows host', async () => {
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `if CONFIG["MAKENSISU"]:
    BRANDING_FILES += [
        "stubinstaller/installing_page.css",
    ]
`
    );
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/stubinstaller/installing_page.css'),
      ''
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('darwin');
    const result = await detectPlatformGate(
      engineDir,
      'browser/branding/mybrowser/stubinstaller/installing_page.css'
    );
    expect(result.gatedOff).toBe(true);
    expect(result.gateExpression).toContain('MAKENSISU');
  });

  it('reports gatedOff:false for the same file on its target host', async () => {
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `if CONFIG["MAKENSISU"]:
    BRANDING_FILES += [
        "stubinstaller/installing_page.css",
    ]
`
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('win32');
    const result = await detectPlatformGate(
      engineDir,
      'browser/branding/mybrowser/stubinstaller/installing_page.css'
    );
    expect(result.gatedOff).toBe(false);
  });

  it('reports gatedOff:false for an ungated file', async () => {
    await ensureDir(join(engineDir, 'browser/branding/mybrowser'));
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `BRANDING_FILES += [
    "icon.png",
]
`
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('darwin');
    const result = await detectPlatformGate(engineDir, 'browser/branding/mybrowser/icon.png');
    expect(result.gatedOff).toBe(false);
  });

  it('returns gatedOff:false when no owning moz.build is found', async () => {
    await ensureDir(join(engineDir, 'isolated'));
    await writeText(join(engineDir, 'isolated/orphan.css'), '');

    const result = await detectPlatformGate(engineDir, 'isolated/orphan.css');
    expect(result.gatedOff).toBe(false);
  });

  it('does not gate off when the expression contains a negation', async () => {
    // Negations like `!= "WINNT"` are conservatively not treated as
    // single-OS gates, since the file may still ship on the current host.
    await ensureDir(join(engineDir, 'browser/components'));
    await writeText(
      join(engineDir, 'browser/components/moz.build'),
      `if CONFIG["OS_TARGET"] != "WINNT":
    SOURCES += [
        "linux_or_mac.cpp",
    ]
`
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('darwin');
    const result = await detectPlatformGate(engineDir, 'browser/components/linux_or_mac.cpp');
    expect(result.gatedOff).toBe(false);
  });

  it('detects a Darwin-only gate on a Linux host', async () => {
    await ensureDir(join(engineDir, 'browser/themes'));
    await writeText(
      join(engineDir, 'browser/themes/moz.build'),
      `if CONFIG["OS_TARGET"] == "Darwin":
    BRANDING_FILES += [
        "macos-only.icns",
    ]
`
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('linux');
    const result = await detectPlatformGate(engineDir, 'browser/themes/macos-only.icns');
    expect(result.gatedOff).toBe(true);
  });

  it('gates a /stubinstaller/ asset on non-Windows hosts via path convention', async () => {
    // Stub-installer CSS is packaged through Makefile.in FILES lists and
    // `nsis/stub.nsh`. There is no `if CONFIG[…]:` block in any ancestor
    // moz.build to parse. The path-fragment gate catches the Windows-only
    // subtree so the audit does not warn on every non-Windows build.
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `BRANDING_FILES += [
    "icon.png",
]
`
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('darwin');
    const result = await detectPlatformGate(
      engineDir,
      'browser/branding/mybrowser/stubinstaller/installing_page.css'
    );
    expect(result.gatedOff).toBe(true);
    expect(result.gateExpression).toContain('stubinstaller');
  });

  it('does not gate the /stubinstaller/ asset on the matching Windows host', async () => {
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));

    vi.spyOn(platform, 'getPlatform').mockReturnValue('win32');
    const result = await detectPlatformGate(
      engineDir,
      'browser/branding/mybrowser/stubinstaller/installing_page.css'
    );
    expect(result.gatedOff).toBe(false);
  });

  it('gates browser/installer/macosx/ sources on non-Darwin hosts', async () => {
    await ensureDir(join(engineDir, 'browser/installer/macosx'));

    vi.spyOn(platform, 'getPlatform').mockReturnValue('linux');
    const result = await detectPlatformGate(engineDir, 'browser/installer/macosx/dmg-layout.png');
    expect(result.gatedOff).toBe(true);
    expect(result.gateExpression).toContain('browser/installer/macosx/');
  });

  it('gates browser/installer/linux/ sources on non-Linux hosts', async () => {
    await ensureDir(join(engineDir, 'browser/installer/linux'));

    vi.spyOn(platform, 'getPlatform').mockReturnValue('darwin');
    const result = await detectPlatformGate(engineDir, 'browser/installer/linux/desktop.in');
    expect(result.gatedOff).toBe(true);
    expect(result.gateExpression).toContain('browser/installer/linux/');
  });

  it('prefers an explicit moz.build gate expression over a conflicting path convention', async () => {
    // A file under /stubinstaller/ that is also wrapped in an explicit
    // `if CONFIG["OS_TARGET"] == "Darwin":` gate (hypothetical fork-specific
    // arrangement) should surface the moz.build expression. moz.build is
    // authoritative, path conventions are a safety net.
    await ensureDir(join(engineDir, 'browser/branding/mybrowser/stubinstaller'));
    await writeText(
      join(engineDir, 'browser/branding/mybrowser/moz.build'),
      `if CONFIG["OS_TARGET"] == "Darwin":
    BRANDING_FILES += [
        "stubinstaller/installing_page.css",
    ]
`
    );

    vi.spyOn(platform, 'getPlatform').mockReturnValue('darwin');
    const result = await detectPlatformGate(
      engineDir,
      'browser/branding/mybrowser/stubinstaller/installing_page.css'
    );
    expect(result.gatedOff).toBe(false);
    expect(result.gateExpression).toContain('Darwin');
  });
});
