// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  isContainedRelativePath,
  isExplicitAbsolutePath,
  isPathInsideRoot,
  normalizePathSlashes,
  stripEnginePrefix,
  toRootRelativePath,
} from '../paths.js';

/**
 * These tests exercise the path-normalization helpers against both POSIX and
 * Windows inputs. They run on whatever platform vitest is hosted on, so the
 * assertions are written against the platform-agnostic contract each helper
 * advertises (forward-slash output, cross-separator absolute detection,
 * containment semantics that ignore separator flavor).
 */
describe('normalizePathSlashes', () => {
  it('converts Windows-style backslashes to forward slashes', () => {
    expect(normalizePathSlashes('a\\b\\c')).toBe('a/b/c');
  });

  it('is idempotent on already-normalized POSIX paths', () => {
    expect(normalizePathSlashes('a/b/c')).toBe('a/b/c');
  });

  it('handles mixed separators in a single path', () => {
    expect(normalizePathSlashes('toolkit\\content/widgets\\moz-button')).toBe(
      'toolkit/content/widgets/moz-button'
    );
  });

  it('handles Windows drive letters', () => {
    expect(normalizePathSlashes('C:\\Users\\dev\\fireforge')).toBe('C:/Users/dev/fireforge');
  });

  it('leaves an empty string unchanged', () => {
    expect(normalizePathSlashes('')).toBe('');
  });
});

describe('isExplicitAbsolutePath', () => {
  it('detects POSIX absolute paths', () => {
    expect(isExplicitAbsolutePath('/tmp/foo')).toBe(true);
    expect(isExplicitAbsolutePath('/')).toBe(true);
  });

  it('detects Windows absolute paths with backslashes', () => {
    expect(isExplicitAbsolutePath('C:\\Users\\dev')).toBe(true);
    expect(isExplicitAbsolutePath('D:\\project')).toBe(true);
  });

  it('detects Windows absolute paths with forward slashes', () => {
    // `c:/foo` is also a valid Windows absolute path shape.
    expect(isExplicitAbsolutePath('C:/Users/dev')).toBe(true);
    expect(isExplicitAbsolutePath('z:/scratch')).toBe(true);
  });

  it('rejects relative paths regardless of separator', () => {
    expect(isExplicitAbsolutePath('./foo')).toBe(false);
    expect(isExplicitAbsolutePath('foo/bar')).toBe(false);
    expect(isExplicitAbsolutePath('foo\\bar')).toBe(false);
    expect(isExplicitAbsolutePath('..\\escape')).toBe(false);
  });
});

describe('isContainedRelativePath', () => {
  it('accepts simple relative paths', () => {
    expect(isContainedRelativePath('a/b')).toBe(true);
    expect(isContainedRelativePath('toolkit/content/widgets/moz-button')).toBe(true);
  });

  it('rejects parent-traversal escapes', () => {
    expect(isContainedRelativePath('../escape')).toBe(false);
    expect(isContainedRelativePath('a/../../b')).toBe(false);
  });

  it('rejects POSIX absolute paths', () => {
    expect(isContainedRelativePath('/etc/passwd')).toBe(false);
  });

  it('rejects Windows absolute paths regardless of separator', () => {
    // These paths are refused cross-platform because the explicit-absolute
    // check matches a drive letter followed by either separator. This
    // matters on Windows because a patch manifest coming from another
    // checkout could otherwise smuggle `C:\\Windows\\system32` past a
    // containment check on a POSIX CI runner.
    expect(isContainedRelativePath('C:\\Windows\\system32')).toBe(false);
    expect(isContainedRelativePath('C:/Windows/system32')).toBe(false);
  });
});

describe('isPathInsideRoot', () => {
  it('accepts a file directly under the root', () => {
    expect(isPathInsideRoot('/root', '/root/foo.txt')).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isPathInsideRoot('/root', '/root')).toBe(true);
  });

  it('rejects sibling directories that share a prefix', () => {
    // `/root2` starts with `/root` but is not under it — relative() yields
    // `../root2/foo.txt` which the check rejects.
    expect(isPathInsideRoot('/root', '/root2/foo.txt')).toBe(false);
  });

  it('rejects parent-traversal escapes from within the root', () => {
    expect(isPathInsideRoot('/root', '/root/../escape/file.txt')).toBe(false);
  });

  it('accepts a relative candidate, resolving against the root', () => {
    expect(isPathInsideRoot('/root', 'nested/file.txt')).toBe(true);
  });

  it('rejects a relative candidate that resolves outside the root', () => {
    expect(isPathInsideRoot('/root', '../outside/file.txt')).toBe(false);
  });
});

describe('toRootRelativePath', () => {
  it('returns a forward-slash relative path', () => {
    expect(toRootRelativePath('/root', '/root/sub/file.txt')).toBe('sub/file.txt');
  });

  it('throws when the candidate escapes the root', () => {
    expect(() => toRootRelativePath('/root', '/other/file.txt')).toThrow(/escapes root/);
  });

  it('throws when a relative candidate escapes the root', () => {
    expect(() => toRootRelativePath('/root', '../escape.txt')).toThrow(/escapes root/);
  });
});

describe('stripEnginePrefix', () => {
  it('strips a POSIX "engine/" prefix', () => {
    expect(stripEnginePrefix('engine/browser/base/content/foo.js')).toBe(
      'browser/base/content/foo.js'
    );
  });

  it('strips a Windows-flavour "engine\\" prefix', () => {
    expect(stripEnginePrefix('engine\\browser\\base\\content\\foo.js')).toBe(
      'browser\\base\\content\\foo.js'
    );
  });

  it('is case-insensitive', () => {
    expect(stripEnginePrefix('Engine/browser/foo.js')).toBe('browser/foo.js');
    expect(stripEnginePrefix('ENGINE/browser/foo.js')).toBe('browser/foo.js');
  });

  it('tolerates leading whitespace before the prefix', () => {
    expect(stripEnginePrefix('  engine/browser/foo.js')).toBe('browser/foo.js');
    expect(stripEnginePrefix('\tengine/browser/foo.js')).toBe('browser/foo.js');
  });

  it('passes through paths without the prefix', () => {
    expect(stripEnginePrefix('browser/base/content/foo.js')).toBe('browser/base/content/foo.js');
    expect(stripEnginePrefix('engine-adjacent/foo.js')).toBe('engine-adjacent/foo.js');
    expect(stripEnginePrefix('')).toBe('');
  });

  it('does not strip a bare "engine" with no separator', () => {
    // `engine` by itself is not the prefix pattern — a caller might mean a
    // literal path named `engine` in the repo root. The pattern requires a
    // trailing separator, so pass-through is correct.
    expect(stripEnginePrefix('engine')).toBe('engine');
  });
});
