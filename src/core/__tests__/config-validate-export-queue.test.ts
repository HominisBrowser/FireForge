// SPDX-License-Identifier: EUPL-1.2
/**
 * `exportQueue` validation: named groups of created files and the directory
 * group budget, refused at config load when malformed.
 */
import { describe, expect, it } from 'vitest';

import { validateConfig } from '../config-validate.js';
import { parseExportQueueConfig } from '../config-validate-export-queue.js';

describe('parseExportQueueConfig', () => {
  it('accepts named groups and a budget', () => {
    const value = {
      groups: [
        { name: 'ui-tiles', paths: ['browser/tiles/**', 'browser/base/content/tiles-*.js'] },
      ],
      maxGroupBytes: 2048,
    };
    expect(parseExportQueueConfig(value)).toEqual(value);
    expect(parseExportQueueConfig({})).toEqual({});
  });

  it('refuses unknown keys, bad names, empty or escaping globs and duplicate names', () => {
    expect(() => parseExportQueueConfig({ order: [] })).toThrow('unknown key "order"');
    expect(() => parseExportQueueConfig({ groups: [{ name: 'UI', paths: ['a'] }] })).toThrow(
      'exportQueue.groups[0].name'
    );
    expect(() => parseExportQueueConfig({ groups: [{ name: 'ui-a', paths: [] }] })).toThrow(
      'exportQueue.groups[0].paths'
    );
    expect(() =>
      parseExportQueueConfig({ groups: [{ name: 'ui-a', paths: ['../x/**'] }] })
    ).toThrow('exportQueue.groups[0].paths[0]');
    expect(() =>
      parseExportQueueConfig({ groups: [{ name: 'ui-a', paths: ['a'], extra: 1 }] })
    ).toThrow('unknown key "extra"');
    expect(() =>
      parseExportQueueConfig({
        groups: [
          { name: 'ui-a', paths: ['a/**'] },
          { name: 'ui-a', paths: ['b/**'] },
        ],
      })
    ).toThrow('names "ui-a" more than once');
    expect(() => parseExportQueueConfig({ maxGroupBytes: 0 })).toThrow('positive integer');
  });

  it('is read from fireforge.json', () => {
    const config = validateConfig({
      name: 'P',
      vendor: 'V',
      appId: 'org.v.p',
      binaryName: 'p',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      exportQueue: { groups: [{ name: 'ui-a', paths: ['a/**'] }] },
    });
    expect(config.exportQueue).toEqual({ groups: [{ name: 'ui-a', paths: ['a/**'] }] });
  });
});
