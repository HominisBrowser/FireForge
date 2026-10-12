// SPDX-License-Identifier: EUPL-1.2
/** Direct unit tests for the `history` config block. */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../errors/config.js';
import type { FireForgeConfig } from '../../types/config.js';
import { parseObject } from '../../utils/parse.js';
import { validateConfig } from '../config-validate.js';
import { parseHistoryBlock } from '../config-validate-history.js';

function makeConfig(): FireForgeConfig {
  return {} as FireForgeConfig;
}

function rec(value: Record<string, unknown>): ReturnType<typeof parseObject> {
  return parseObject(value, 'config');
}

describe('parseHistoryBlock', () => {
  it('leaves config.history unset when the block is absent', () => {
    const config = makeConfig();
    parseHistoryBlock(rec({}), config);
    expect(config.history).toBeUndefined();
  });

  it('accepts an empty block and a project-relative path', () => {
    const empty = makeConfig();
    parseHistoryBlock(rec({ history: {} }), empty);
    expect(empty.history).toEqual({});

    const config = makeConfig();
    parseHistoryBlock(rec({ history: { path: 'logs/history.jsonl' } }), config);
    expect(config.history).toEqual({ path: 'logs/history.jsonl' });
  });

  it('rejects a non-object block', () => {
    for (const bad of ['string', 42, ['a'], null]) {
      expect(() => {
        parseHistoryBlock(rec({ history: bad }), makeConfig());
      }).toThrow(ConfigError);
    }
  });

  it('rejects a path that is not a project-relative file path', () => {
    for (const bad of [42, '', '   ', '.', '../outside.jsonl', '/abs/history.jsonl', 'a\nb']) {
      expect(() => {
        parseHistoryBlock(rec({ history: { path: bad } }), makeConfig());
      }).toThrow(/history\.path/);
    }
  });

  it('is wired into validateConfig', () => {
    const config = validateConfig({
      name: 'Browser',
      vendor: 'Vendor',
      appId: 'org.example.browser',
      binaryName: 'browser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
      history: { path: 'logs/history.jsonl' },
    });
    expect(config.history).toEqual({ path: 'logs/history.jsonl' });
  });
});
