// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { readTokenFile, tokenFilePath, tokenSettings } from './settings.js';

describe('tokenSettings', () => {
  it('falls back to the binary name for the file and the prefix', () => {
    expect(tokenSettings(undefined, 'acme')).toEqual({
      file: 'browser/themes/shared/acme-tokens.css',
      prefix: '--acme-',
      exempt: new Set(),
      platformPrefixes: ['--moz-'],
      siblingSheets: {},
    });
  });

  it('takes the component configuration keys', () => {
    const settings = tokenSettings(
      {
        tokenFile: 'browser/themes/brand/tokens.css',
        tokenPrefix: '--brand-',
        tokenAllowlist: ['--a'],
        runtimeVariables: ['--b'],
        platformPrefixes: ['--moz-', '--in-content-'],
        tokenSiblingSheets: { 'x/*.css': ['x/base.css'] },
      },
      'acme'
    );
    expect(settings).toEqual({
      file: 'browser/themes/brand/tokens.css',
      prefix: '--brand-',
      exempt: new Set(['--a', '--b']),
      platformPrefixes: ['--moz-', '--in-content-'],
      siblingSheets: { 'x/*.css': ['x/base.css'] },
    });
    expect(tokenFilePath('acme', { tokenFile: 'a/t.css' })).toBe('a/t.css');
  });
});

describe('readTokenFile', () => {
  it('reads the file, and names the missing one with what to do', async () => {
    const files = {
      read: (path: string) => Promise.resolve(path === 'a.css' ? ':root {}' : undefined),
    };
    expect(await readTokenFile(files, 'a.css')).toBe(':root {}');
    await expect(readTokenFile(files, 'b.css')).rejects.toMatchObject({
      code: 'token-file-missing',
      message: 'Token file not found: b.css',
      hint: expect.stringMatching(/tokenFile in furnace\.json/) as unknown,
    });
  });
});
