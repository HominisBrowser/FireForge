// SPDX-License-Identifier: EUPL-1.2
/**
 * Direct unit tests for the `test` and `externalToolchains` config blocks.
 *
 * This validator runs on EVERY config load and sat at 10.5% line / 4.5% branch
 * with no test file importing it at all — it was reached only transitively
 * through `validateConfig`, and no existing fixture supplied either block. It
 * is pure and does no I/O, so every rejection arm is cheap to pin.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../errors/config.js';
import type { FireForgeConfig } from '../../types/config.js';
import { parseObject } from '../../utils/parse.js';
import {
  parseExternalToolchainsBlock,
  parseTestBlock,
} from '../config-validate-test-toolchains.js';

/** Empty config shell — only the fields these parsers assign are asserted. */
function makeConfig(): FireForgeConfig {
  return {} as FireForgeConfig;
}

function rec(value: Record<string, unknown>): ReturnType<typeof parseObject> {
  return parseObject(value, 'config');
}

describe('parseTestBlock', () => {
  it('leaves config.test unset when the block is absent', () => {
    const config = makeConfig();
    parseTestBlock(rec({}), config);
    expect(config.test).toBeUndefined();
  });

  it('rejects a non-object test block', () => {
    for (const bad of ['string', 42, true, ['a'], null]) {
      expect(() => {
        parseTestBlock(rec({ test: bad }), makeConfig());
      }).toThrow(ConfigError);
    }
  });

  it('accepts an empty test block', () => {
    const config = makeConfig();
    parseTestBlock(rec({ test: {} }), config);
    expect(config.test).toEqual({});
  });

  describe('canaryPath', () => {
    it('accepts a contained relative path', () => {
      const config = makeConfig();
      parseTestBlock(rec({ test: { canaryPath: 'browser/base/test/canary.js' } }), config);
      expect(config.test?.canaryPath).toBe('browser/base/test/canary.js');
    });

    it('rejects a non-string', () => {
      expect(() => {
        parseTestBlock(rec({ test: { canaryPath: 42 } }), makeConfig());
      }).toThrow(/"test\.canaryPath" must be a string/);
    });

    it('rejects empty and whitespace-only values', () => {
      for (const bad of ['', '   ', '\t\n']) {
        expect(() => {
          parseTestBlock(rec({ test: { canaryPath: bad } }), makeConfig());
        }).toThrow(/"test\.canaryPath" must be a project-relative path/);
      }
    });

    it('rejects absolute paths, parent escapes, and NUL bytes', () => {
      for (const bad of ['/etc/passwd', '../outside.js', 'a/../../b.js', 'a\0b.js']) {
        expect(() => {
          parseTestBlock(rec({ test: { canaryPath: bad } }), makeConfig());
        }).toThrow(/"test\.canaryPath" must be a project-relative path/);
      }
    });
  });

  describe('canaryTimeoutSeconds', () => {
    it('accepts the inclusive bounds', () => {
      for (const good of [1, 600, 45]) {
        const config = makeConfig();
        parseTestBlock(rec({ test: { canaryTimeoutSeconds: good } }), config);
        expect(config.test?.canaryTimeoutSeconds).toBe(good);
      }
    });

    it('rejects each of the four failure sub-conditions', () => {
      const cases: Array<[string, unknown]> = [
        ['non-number', '30'],
        ['non-integer', 1.5],
        ['below the lower bound', 0],
        ['above the upper bound', 601],
      ];
      for (const [label, bad] of cases) {
        expect(() => {
          parseTestBlock(rec({ test: { canaryTimeoutSeconds: bad } }), makeConfig());
        }, label).toThrow(/"test\.canaryTimeoutSeconds" must be an integer in 1\.\.600/);
      }
    });

    it('rejects NaN and Infinity', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => {
          parseTestBlock(rec({ test: { canaryTimeoutSeconds: bad } }), makeConfig());
        }).toThrow(ConfigError);
      }
    });
  });

  it('carries both fields together', () => {
    const config = makeConfig();
    parseTestBlock(rec({ test: { canaryPath: 'a/b.js', canaryTimeoutSeconds: 90 } }), config);
    expect(config.test).toEqual({ canaryPath: 'a/b.js', canaryTimeoutSeconds: 90 });
  });
});

describe('parseExternalToolchainsBlock', () => {
  const minimal = { name: 'iOS', tools: [{ name: 'xcodebuild' }] };

  it('leaves the field unset when absent', () => {
    const config = makeConfig();
    parseExternalToolchainsBlock(rec({}), config);
    expect(config.externalToolchains).toBeUndefined();
  });

  it('rejects a non-array block', () => {
    for (const bad of [{}, 'x', 3, true, null]) {
      expect(() => {
        parseExternalToolchainsBlock(rec({ externalToolchains: bad }), makeConfig());
      }).toThrow(/"externalToolchains" must be an array/);
    }
  });

  it('accepts an empty array', () => {
    const config = makeConfig();
    parseExternalToolchainsBlock(rec({ externalToolchains: [] }), config);
    expect(config.externalToolchains).toEqual([]);
  });

  it('rejects each non-object entry shape and names the index', () => {
    for (const bad of ['x', 42, null, ['nested']]) {
      expect(() => {
        parseExternalToolchainsBlock(rec({ externalToolchains: [minimal, bad] }), makeConfig());
      }).toThrow(/"externalToolchains\[1\]" must be an object/);
    }
  });

  it('rejects a missing, non-string, or blank toolchain name', () => {
    for (const bad of [undefined, 42, '', '   ']) {
      expect(() => {
        parseExternalToolchainsBlock(
          rec({ externalToolchains: [{ name: bad, tools: [{ name: 't' }] }] }),
          makeConfig()
        );
      }).toThrow(/"externalToolchains\[0\]\.name" must be a non-empty string/);
    }
  });

  it('rejects a missing, non-array, or empty tools list', () => {
    for (const bad of [undefined, 'x', {}, []]) {
      expect(() => {
        parseExternalToolchainsBlock(
          rec({ externalToolchains: [{ name: 'iOS', tools: bad }] }),
          makeConfig()
        );
      }).toThrow(/"externalToolchains\[0\]\.tools" must be a non-empty array/);
    }
  });

  describe('tool requirements', () => {
    function parseTool(tool: unknown): FireForgeConfig {
      const config = makeConfig();
      parseExternalToolchainsBlock(
        rec({ externalToolchains: [{ name: 'iOS', tools: [tool] }] }),
        config
      );
      return config;
    }

    it('keeps only the name when no optional field is supplied', () => {
      // The three conditional spreads must omit absent keys entirely rather
      // than writing `undefined` — `exactOptionalPropertyTypes` is on.
      expect(parseTool({ name: 'xcodebuild' }).externalToolchains?.[0]?.tools[0]).toEqual({
        name: 'xcodebuild',
      });
    });

    it('carries every optional field when supplied', () => {
      expect(
        parseTool({ name: 'xcodebuild', path: '/usr/bin/xcodebuild', xcrun: true, required: false })
          .externalToolchains?.[0]?.tools[0]
      ).toEqual({
        name: 'xcodebuild',
        path: '/usr/bin/xcodebuild',
        xcrun: true,
        required: false,
      });
    });

    it('rejects a non-object tool and names both indices', () => {
      for (const bad of ['x', 7, null, ['a']]) {
        expect(() => parseTool(bad)).toThrow(
          /"externalToolchains\[0\]\.tools\[0\]" must be an object/
        );
      }
    });

    it('rejects a missing, non-string, or blank tool name', () => {
      for (const bad of [undefined, 9, '', '  ']) {
        expect(() => parseTool({ name: bad })).toThrow(
          /"externalToolchains\[0\]\.tools\[0\]\.name" must be a non-empty string/
        );
      }
    });

    it('rejects a present-but-blank or non-string path', () => {
      for (const bad of [42, '', '   ']) {
        expect(() => parseTool({ name: 't', path: bad })).toThrow(
          /"externalToolchains\[0\]\.tools\[0\]\.path" must be a non-empty string/
        );
      }
    });

    it('rejects non-boolean xcrun and required', () => {
      expect(() => parseTool({ name: 't', xcrun: 'yes' })).toThrow(
        /"externalToolchains\[0\]\.tools\[0\]\.xcrun" must be a boolean/
      );
      expect(() => parseTool({ name: 't', required: 1 })).toThrow(
        /"externalToolchains\[0\]\.tools\[0\]\.required" must be a boolean/
      );
    });
  });

  it('maps multiple toolchains and tools in order', () => {
    const config = makeConfig();
    parseExternalToolchainsBlock(
      rec({
        externalToolchains: [
          { name: 'iOS', tools: [{ name: 'xcodebuild', xcrun: true }, { name: 'simctl' }] },
          { name: 'Android', tools: [{ name: 'adb', required: false }] },
        ],
      }),
      config
    );
    expect(config.externalToolchains).toEqual([
      { name: 'iOS', tools: [{ name: 'xcodebuild', xcrun: true }, { name: 'simctl' }] },
      { name: 'Android', tools: [{ name: 'adb', required: false }] },
    ]);
  });
});
