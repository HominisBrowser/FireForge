// SPDX-License-Identifier: EUPL-1.2
/**
 * The macOS SDK link probe. Every host interaction is mocked: CI must not
 * depend on a host SDK or a bootstrapped clang.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args: string[],
      options?: unknown
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  >()
);
const existsMock = vi.hoisted(() => vi.fn<(path: string) => boolean>());
const readdirMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string[]>>());

vi.mock('../../utils/process.js', () => ({ exec: execMock }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsMock,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir: readdirMock,
}));

import { makeProjectPaths } from '../../test-utils/index.js';
import type { DoctorCheckContext } from '../doctor-check-core.js';
import {
  bootstrappedClangPath,
  checkMacosSdkLink,
  MACOS_SDK_LINK_DOCTOR_CHECK,
} from '../doctor-macos-sdk.js';

const PINNED = '/Users/dev/.mozbuild/MacOSX26.5.sdk';
const XCODE =
  '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk';

type Reply = { stdout?: string; stderr?: string; exitCode?: number };
function scripted(replies: {
  mozconfig?: Reply;
  xcrun?: Reply;
  clang?: Reply;
  xcodeSelect?: Reply;
}): void {
  execMock.mockImplementation((command, args) => {
    const reply =
      command === '/bin/sh'
        ? replies.mozconfig
        : command === 'xcrun'
          ? replies.xcrun
          : command === 'xcode-select'
            ? replies.xcodeSelect
            : args.includes('-isysroot')
              ? replies.clang
              : undefined;
    return Promise.resolve({
      stdout: reply?.stdout ?? '',
      stderr: reply?.stderr ?? '',
      exitCode: reply?.exitCode ?? 0,
    });
  });
}

describe('checkMacosSdkLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsMock.mockImplementation((path) => path.endsWith('/mozconfig'));
    readdirMock.mockResolvedValue([]);
  });

  it('passes when the bootstrapped clang links against the mozconfig SDK', async () => {
    scripted({ mozconfig: { stdout: `${PINNED}\n` } });

    const result = await checkMacosSdkLink('/project/engine');

    expect(result.severity).toBe('ok');
    expect(result.message).toContain(`${PINNED}, from mozconfig`);
    // The mozconfig answered, so configure's auto-detection is not consulted.
    expect(execMock.mock.calls.some(([command]) => command === 'xcrun')).toBe(false);
    const link = execMock.mock.calls.find(([, args]) => args.includes('-isysroot'));
    expect(link?.[0]).toBe(bootstrappedClangPath());
    expect(link?.[1]).toContain(PINNED);
  });

  it('names the mismatch and lists the installed SDKs when the link fails', async () => {
    existsMock.mockImplementation((path) => !path.endsWith('/mozconfig'));
    scripted({
      xcrun: { stdout: `${XCODE}\n` },
      xcodeSelect: { stdout: '/Applications/Xcode.app/Contents/Developer\n' },
      clang: {
        exitCode: 1,
        stderr:
          'ld64.lld: error: could not load TAPI file at /x/libSystem.tbd: malformed file\nclang: error: linker command failed',
      },
    });
    readdirMock.mockImplementation((root) =>
      Promise.resolve(
        root === '/Library/Developer/CommandLineTools/SDKs'
          ? ['MacOSX26.5.sdk', 'MacOSX27.0.sdk', 'README']
          : []
      )
    );

    const result = await checkMacosSdkLink('/project/engine');

    expect(result.severity).toBe('warning');
    expect(result.message).toContain(`cannot link against ${XCODE} (from xcrun)`);
    expect(result.message).toContain('ld64.lld: error: could not load TAPI file');
    expect(result.message).toContain('/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk');
    expect(result.message).not.toContain('README');
    expect(result.fix).toContain('--with-macos-sdk');
  });

  it('reports a mozconfig whose SDK selection exits non-zero', async () => {
    scripted({ mozconfig: { exitCode: 1, stderr: 'ERROR: no pinned macOS SDK found\n' } });

    const result = await checkMacosSdkLink('/project/engine');

    expect(result.severity).toBe('warning');
    expect(result.message).toContain('ERROR: no pinned macOS SDK found');
  });
});

describe('MACOS_SDK_LINK_DOCTOR_CHECK gating', () => {
  const originalPlatform = process.platform;
  const ctx = { engineExists: true, paths: makeProjectPaths() } as unknown as DoctorCheckContext;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('is a no-op off macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    existsMock.mockReturnValue(true);
    expect(MACOS_SDK_LINK_DOCTOR_CHECK.skipIf?.(ctx)).toBe(true);
  });

  it('is a no-op without a bootstrapped clang', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    existsMock.mockReturnValue(false);
    expect(MACOS_SDK_LINK_DOCTOR_CHECK.skipIf?.(ctx)).toBe(true);
  });

  it('runs on macOS with a bootstrapped clang', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    existsMock.mockReturnValue(true);
    expect(MACOS_SDK_LINK_DOCTOR_CHECK.skipIf?.(ctx)).toBe(false);
  });
});

describe('doctor registry', () => {
  it('runs the SDK link probe as part of fireforge doctor', async () => {
    const { DOCTOR_CHECK_ORDER } = await import('../doctor.js');
    expect(DOCTOR_CHECK_ORDER).toContain('macOS SDK links with the bootstrapped clang');
  });
});
