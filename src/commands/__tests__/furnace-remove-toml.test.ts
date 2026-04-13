// SPDX-License-Identifier: EUPL-1.2
/**
 * Targeted tests for the removeTomlSection helper used by furnace remove.
 * Since removeTomlSection is a private function, we test it indirectly through
 * the module's internal behavior. This file duplicates the logic for unit
 * testing the TOML removal in isolation.
 */
import { describe, expect, it } from 'vitest';

/**
 * Mirror of the removeTomlSection function from furnace/remove.ts.
 * Kept in sync for targeted unit testing of the TOML cleanup logic.
 */
function removeTomlSection(toml: string, testFileName: string): string {
  const lines = toml.split('\n');
  const header = `["${testFileName}"]`;
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]?.trim() === header) {
      i++;
      while (i < lines.length && !/^\s*\[/.test(lines[i] ?? '')) {
        i++;
      }
      while (result.length > 0 && result[result.length - 1]?.trim() === '') {
        result.pop();
      }
      if (i < lines.length && result.length > 0) {
        result.push('');
      }
    } else {
      result.push(lines[i] ?? '');
      i++;
    }
  }

  while (result.length > 0 && result[result.length - 1]?.trim() === '') {
    result.pop();
  }
  return result.join('\n') + '\n';
}

describe('removeTomlSection', () => {
  it('removes a standalone section header', () => {
    const toml = `["browser_test_one.js"]\n["browser_test_two.js"]\n`;
    const result = removeTomlSection(toml, 'browser_test_one.js');
    expect(result).toBe(`["browser_test_two.js"]\n`);
  });

  it('removes a section with metadata lines below the header', () => {
    const toml = [
      '["browser_test_one.js"]',
      'skip-if = ["os == \'linux\'"]',
      '',
      '["browser_test_two.js"]',
      '',
    ].join('\n');
    const result = removeTomlSection(toml, 'browser_test_one.js');
    expect(result).toBe('["browser_test_two.js"]\n');
  });

  it('removes the last section in the file', () => {
    const toml = [
      '["browser_test_one.js"]',
      '',
      '["browser_test_two.js"]',
      'skip-if = ["os == \'win\'"]',
      '',
    ].join('\n');
    const result = removeTomlSection(toml, 'browser_test_two.js');
    expect(result).toBe('["browser_test_one.js"]\n');
  });

  it('handles a section with multiple metadata keys', () => {
    const toml = [
      '["browser_test_one.js"]',
      'support-files = ["head.js"]',
      'skip-if = ["os == \'linux\'"]',
      'tags = "custom"',
      '',
      '["browser_test_two.js"]',
      '',
    ].join('\n');
    const result = removeTomlSection(toml, 'browser_test_one.js');
    expect(result).toBe('["browser_test_two.js"]\n');
  });

  it('preserves other sections unchanged', () => {
    const toml = [
      '["browser_test_alpha.js"]',
      'tags = "first"',
      '',
      '["browser_test_beta.js"]',
      '',
      '["browser_test_gamma.js"]',
      'tags = "third"',
      '',
    ].join('\n');
    const result = removeTomlSection(toml, 'browser_test_beta.js');
    expect(result).toBe(
      [
        '["browser_test_alpha.js"]',
        'tags = "first"',
        '',
        '["browser_test_gamma.js"]',
        'tags = "third"',
        '',
      ].join('\n')
    );
  });

  it('handles removing from a single-section file', () => {
    const toml = '["browser_test_one.js"]\n';
    const result = removeTomlSection(toml, 'browser_test_one.js');
    expect(result).toBe('\n');
  });

  it('does not modify the file if the section is not found', () => {
    const toml = '["browser_test_one.js"]\n';
    const result = removeTomlSection(toml, 'browser_test_nonexistent.js');
    expect(result).toBe('["browser_test_one.js"]\n');
  });
});
