// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation of the size-rule keys of `patchLint`: `fileSizeMetric`,
 * `patchSizeThresholds`, `patchSizeMetric` and `patchSizeRegistrationFiles`.
 * An out-of-order triple silently disables a band, so it has to fail at
 * config load rather than at the first lint run.
 */
import { describe, expect, it } from 'vitest';

import type { PatchLintConfig } from '../../types/config.js';
import { validateConfig } from '../config.js';

function withPatchLint(patchLint: unknown): unknown {
  return {
    name: 'My Browser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    build: { jobs: 16 },
    license: 'MPL-2.0',
    wire: { subscriptDir: 'browser/base/content' },
    patchLint,
  };
}

const parse = (patchLint: unknown): PatchLintConfig | undefined =>
  validateConfig(withPatchLint(patchLint)).patchLint;

describe('patchLint size keys', () => {
  it('accepts the Hominis target configuration (HF-3879) unchanged', () => {
    const target = {
      fileSizeMetric: 'code',
      fileSizeThresholds: {
        general: { notice: 500, warning: 800, error: 1000 },
        test: { notice: 1000, warning: 1300, error: 1500 },
      },
      patchSizeMetric: 'addedCode',
      patchSizeRegistrationFiles: [
        'jar.mn',
        'moz.build',
        'components.conf',
        'customElements.js',
        '*.toml',
        '*.ini',
        'package-manifest.in',
        'jsconfig*.json',
      ],
      patchSizeThresholds: {
        general: {
          lines: { notice: 1000, warning: 2000, error: 4000 },
          files: { notice: 8, warning: 12, error: 24 },
        },
        test: {
          lines: { notice: 1500, warning: 3000, error: 6000 },
          files: { notice: 8, warning: 12, error: 24 },
        },
        branding: {
          lines: { notice: 8000, warning: 18000, error: 30000 },
          files: { notice: 60, warning: 60, error: 90 },
        },
      },
    };
    expect(parse(target)).toEqual(target);
  });

  it('leaves every key unset by default', () => {
    expect(parse({})).toEqual({});
  });

  it('rejects an unknown metric', () => {
    expect(() => parse({ fileSizeMetric: 'tokens' })).toThrow(
      'Config field "patchLint.fileSizeMetric" must be one of: raw, code'
    );
    expect(() => parse({ patchSizeMetric: 'added' })).toThrow(
      'Config field "patchLint.patchSizeMetric" must be one of: diff, addedCode'
    );
  });

  it('rejects a malformed registration list', () => {
    const message =
      'Config field "patchLint.patchSizeRegistrationFiles" must be an array of non-empty strings';
    expect(() => parse({ patchSizeRegistrationFiles: 'jar.mn' })).toThrow(message);
    expect(() => parse({ patchSizeRegistrationFiles: [''] })).toThrow(message);
    expect(() => parse({ patchSizeRegistrationFiles: [3] })).toThrow(message);
  });

  it('rejects malformed patchSizeThresholds shapes', () => {
    expect(() => parse({ patchSizeThresholds: 3 })).toThrow(
      'Config field "patchLint.patchSizeThresholds" must be a plain object'
    );
    expect(() => parse({ patchSizeThresholds: { huge: {} } })).toThrow(
      'Config field "patchLint.patchSizeThresholds" has unknown key "huge"'
    );
    expect(() => parse({ patchSizeThresholds: { test: [] } })).toThrow(
      'Config field "patchLint.patchSizeThresholds.test" must be a plain object'
    );
    expect(() => parse({ patchSizeThresholds: { test: { bytes: {} } } })).toThrow(
      'Config field "patchLint.patchSizeThresholds.test" has unknown key "bytes"'
    );
    expect(() => parse({ patchSizeThresholds: { general: { lines: { warning: 0 } } } })).toThrow(
      'Config field "patchLint.patchSizeThresholds.general.lines.warning" must be a positive integer'
    );
  });

  it('validates notice <= warning <= error against the merged triple', () => {
    // Only `notice` set, above the default lines warning (1500).
    expect(() => parse({ patchSizeThresholds: { general: { lines: { notice: 1600 } } } })).toThrow(
      'Config field "patchLint.patchSizeThresholds.general.lines" must satisfy notice <= warning <= error (resolved: 1600/1500/3000)'
    );
    // files.notice above the default files warning (5).
    expect(() => parse({ patchSizeThresholds: { test: { files: { notice: 8 } } } })).toThrow(
      'Config field "patchLint.patchSizeThresholds.test.files" must satisfy notice <= warning <= error (resolved: 8/5/none)'
    );
    expect(() =>
      parse({ patchSizeThresholds: { branding: { files: { warning: 60, error: 50 } } } })
    ).toThrow('(resolved: 60/60/50)');
  });
});
