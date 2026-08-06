// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  compileAllowlistFromFile,
  compileAllowlistFromStrings,
  matchAllowlist,
  matchesSmokeError,
  SMOKE_ERROR_PATTERNS,
} from '../smoke-patterns.js';

describe('matchesSmokeError', () => {
  it('flags a vanilla Firefox JavaScript error prefix', () => {
    const line =
      'JavaScript error: chrome://global/content/elements/moz-card.mjs, line 17: TypeError: foo is not a function';
    expect(matchesSmokeError(line)).toBe(true);
  });

  it('flags a console.error prefix regardless of letter case', () => {
    expect(matchesSmokeError('console.error: AsyncShutdown blocker timed out')).toBe(true);
    expect(matchesSmokeError('CONSOLE.ERROR: upstream-trait')).toBe(true);
  });

  it('flags the bracketed [JavaScript Error] prefix', () => {
    expect(matchesSmokeError('[JavaScript Error] "unhandled rejection"')).toBe(true);
    expect(matchesSmokeError('[JavaScript Warning] deprecated API')).toBe(true);
  });

  it('flags the IPC parent-fatal prefix', () => {
    expect(matchesSmokeError('###!!! [Parent] Error: GetPluginOccupancy')).toBe(true);
  });

  it('ignores embedded mentions that do not start the line', () => {
    // Avoids treating descriptive prose as a runtime error. A line has to
    // *start* with the prefix to count.
    expect(matchesSmokeError('see the JavaScript error: pattern documented above')).toBe(false);
    expect(matchesSmokeError('notes on console.error: prefixes in Firefox logs')).toBe(false);
  });

  it('ignores benign diagnostic lines', () => {
    expect(matchesSmokeError('Launching browser...')).toBe(false);
    expect(matchesSmokeError('INFO: started browser_delayed_startup_finished')).toBe(false);
    expect(matchesSmokeError('')).toBe(false);
  });

  it('exports the pattern list so operators can audit it', () => {
    expect(SMOKE_ERROR_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of SMOKE_ERROR_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe('matchAllowlist', () => {
  it('returns -1 when the allowlist is empty', () => {
    expect(matchAllowlist('JavaScript error: whatever', [])).toBe(-1);
  });

  it('returns the index of the first matching entry', () => {
    const allow = compileAllowlistFromStrings(['synthetic', 'Async']);
    expect(matchAllowlist('JavaScript error: synthetic failure', allow)).toBe(0);
    expect(matchAllowlist('console.error: AsyncShutdown blocker', allow)).toBe(1);
  });

  it('credits the FIRST entry when several match (deterministic attribution)', () => {
    const allow = compileAllowlistFromStrings(['Async', 'AsyncShutdown']);
    expect(matchAllowlist('console.error: AsyncShutdown blocker', allow)).toBe(0);
  });

  it('returns -1 when no entry matches', () => {
    const allow = compileAllowlistFromStrings(['synthetic']);
    expect(matchAllowlist('JavaScript error: real failure', allow)).toBe(-1);
  });
});

describe('compileAllowlistFromFile', () => {
  it('compiles each non-comment, non-blank line and retains source + file:line origin', () => {
    const body = [
      '# Comment — leading # skips the line.',
      '',
      'synthetic test error',
      '   ',
      'AsyncShutdown blocker',
      '# trailing comment',
    ].join('\n');
    const result = compileAllowlistFromFile(body, '/tmp/allow.txt');
    expect(result).toHaveLength(2);
    expect(result[0]?.pattern.test('JavaScript error: synthetic test error observed')).toBe(true);
    expect(result[1]?.pattern.test('console.error: AsyncShutdown blocker')).toBe(true);
    expect(result[0]?.source).toBe('synthetic test error');
    // Origins carry the ORIGINAL file line numbers, comments/blanks included.
    expect(result[0]?.origin).toBe('/tmp/allow.txt:3');
    expect(result[1]?.origin).toBe('/tmp/allow.txt:5');
  });

  it('handles CRLF-terminated input', () => {
    const body = 'foo\r\nbar\r\n';
    const result = compileAllowlistFromFile(body, '/tmp/allow.txt');
    expect(result).toHaveLength(2);
    expect(result[0]?.pattern.source).toBe('foo');
    expect(result[1]?.pattern.source).toBe('bar');
  });

  it('throws with file and line context when a pattern is invalid', () => {
    const body = ['valid', '[unterminated'].join('\n');
    expect(() => compileAllowlistFromFile(body, '/tmp/allow.txt')).toThrow(/\/tmp\/allow\.txt:2/);
  });
});

describe('compileAllowlistFromStrings', () => {
  it('compiles each input string with a flag-position origin', () => {
    const result = compileAllowlistFromStrings(['synthetic', 'Async']);
    expect(result).toHaveLength(2);
    expect(result[0]?.pattern.source).toBe('synthetic');
    expect(result[1]?.pattern.source).toBe('Async');
    expect(result[0]?.origin).toBe('--console-allow #1');
    expect(result[1]?.origin).toBe('--console-allow #2');
  });

  it('throws with position and input context when a pattern is invalid', () => {
    expect(() => compileAllowlistFromStrings(['ok', '[unterminated'])).toThrow(
      /position 2.*"\[unterminated"/
    );
  });
});
