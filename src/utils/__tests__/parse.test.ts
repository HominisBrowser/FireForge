// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { parseObject } from '../parse.js';

describe('parseObject', () => {
  it('throws when input is not an object', () => {
    expect(() => parseObject(null, 'data')).toThrow('data must be an object');
    expect(() => parseObject('string', 'data')).toThrow('data must be an object');
    expect(() => parseObject(42, 'data')).toThrow('data must be an object');
    expect(() => parseObject([], 'data')).toThrow('data must be an object');
  });

  it('wraps a plain object successfully', () => {
    const rec = parseObject({ key: 'value' }, 'test');
    expect(rec.string('key')).toBe('value');
  });
});

describe('ParsedRecord.string', () => {
  it('extracts a string field', () => {
    const rec = parseObject({ name: 'hello' }, 'obj');
    expect(rec.string('name')).toBe('hello');
  });

  it('throws when field is missing', () => {
    const rec = parseObject({}, 'obj');
    expect(() => rec.string('name')).toThrow('obj.name must be a string');
  });

  it('throws when field is not a string', () => {
    const rec = parseObject({ name: 42 }, 'obj');
    expect(() => rec.string('name')).toThrow('obj.name must be a string');
  });
});

describe('ParsedRecord.optionalString', () => {
  it('returns undefined for missing field', () => {
    const rec = parseObject({}, 'obj');
    expect(rec.optionalString('name')).toBeUndefined();
  });

  it('returns the string when present', () => {
    const rec = parseObject({ name: 'hello' }, 'obj');
    expect(rec.optionalString('name')).toBe('hello');
  });

  it('throws when present but not a string', () => {
    const rec = parseObject({ name: 123 }, 'obj');
    expect(() => rec.optionalString('name')).toThrow('obj.name must be a string');
  });
});

describe('ParsedRecord.number', () => {
  it('extracts a number field', () => {
    const rec = parseObject({ count: 42 }, 'obj');
    expect(rec.number('count')).toBe(42);
  });

  it('throws for NaN', () => {
    const rec = parseObject({ count: NaN }, 'obj');
    expect(() => rec.number('count')).toThrow('obj.count must be a number');
  });
});

describe('ParsedRecord.nonNegativeInteger', () => {
  it('accepts zero', () => {
    const rec = parseObject({ order: 0 }, 'obj');
    expect(rec.nonNegativeInteger('order')).toBe(0);
  });

  it('accepts positive integers', () => {
    const rec = parseObject({ order: 5 }, 'obj');
    expect(rec.nonNegativeInteger('order')).toBe(5);
  });

  it('rejects negative numbers', () => {
    const rec = parseObject({ order: -1 }, 'obj');
    expect(() => rec.nonNegativeInteger('order')).toThrow(
      'obj.order must be a non-negative integer'
    );
  });

  it('rejects floats', () => {
    const rec = parseObject({ order: 1.5 }, 'obj');
    expect(() => rec.nonNegativeInteger('order')).toThrow(
      'obj.order must be a non-negative integer'
    );
  });

  it('rejects strings', () => {
    const rec = parseObject({ order: '1' }, 'obj');
    expect(() => rec.nonNegativeInteger('order')).toThrow(
      'obj.order must be a non-negative integer'
    );
  });
});

describe('ParsedRecord.optionalNonNegativeInteger', () => {
  it('returns undefined for missing field', () => {
    const rec = parseObject({}, 'obj');
    expect(rec.optionalNonNegativeInteger('count')).toBeUndefined();
  });

  it('returns the integer when valid', () => {
    const rec = parseObject({ count: 10 }, 'obj');
    expect(rec.optionalNonNegativeInteger('count')).toBe(10);
  });

  it('rejects invalid values when present', () => {
    const rec = parseObject({ count: -5 }, 'obj');
    expect(() => rec.optionalNonNegativeInteger('count')).toThrow(
      'obj.count must be a non-negative integer'
    );
  });
});

describe('ParsedRecord.stringEnum', () => {
  const isColor = (v: string): v is 'red' | 'blue' => ['red', 'blue'].includes(v);

  it('returns valid enum value', () => {
    const rec = parseObject({ color: 'red' }, 'obj');
    expect(rec.stringEnum('color', isColor, 'one of: red, blue')).toBe('red');
  });

  it('throws for invalid enum value', () => {
    const rec = parseObject({ color: 'green' }, 'obj');
    expect(() => rec.stringEnum('color', isColor, 'one of: red, blue')).toThrow(
      'obj.color must be one of: red, blue'
    );
  });
});

describe('ParsedRecord.validatedString', () => {
  it('returns the string when check passes', () => {
    const rec = parseObject({ version: '1.0' }, 'obj');
    expect(rec.validatedString('version', (v) => v.includes('.'), 'a dotted version')).toBe('1.0');
  });

  it('throws when check fails', () => {
    const rec = parseObject({ version: 'abc' }, 'obj');
    expect(() =>
      rec.validatedString('version', (v) => v.includes('.'), 'a dotted version')
    ).toThrow('obj.version must be a dotted version');
  });
});

describe('ParsedRecord.stringArray', () => {
  it('extracts an array of strings', () => {
    const rec = parseObject({ files: ['a.js', 'b.js'] }, 'obj');
    expect(rec.stringArray('files')).toEqual(['a.js', 'b.js']);
  });

  it('returns a copy, not the original array', () => {
    const original = ['a.js'];
    const rec = parseObject({ files: original }, 'obj');
    const result = rec.stringArray('files');
    expect(result).not.toBe(original);
  });

  it('throws when not an array', () => {
    const rec = parseObject({ files: 'a.js' }, 'obj');
    expect(() => rec.stringArray('files')).toThrow('obj.files must be an array of strings');
  });

  it('throws when array contains non-strings', () => {
    const rec = parseObject({ files: ['a.js', 42] }, 'obj');
    expect(() => rec.stringArray('files')).toThrow('obj.files must be an array of strings');
  });
});

describe('ParsedRecord.object', () => {
  it('returns a nested ParsedRecord with correct label', () => {
    const rec = parseObject({ inner: { name: 'test' } }, 'root');
    const inner = rec.object('inner');
    expect(inner.string('name')).toBe('test');
  });

  it('builds nested labels correctly', () => {
    const rec = parseObject({ inner: { deep: 42 } }, 'root');
    const inner = rec.object('inner');
    expect(() => inner.string('deep')).toThrow('root.inner.deep must be a string');
  });

  it('throws when field is not an object', () => {
    const rec = parseObject({ inner: 'not-object' }, 'root');
    expect(() => rec.object('inner')).toThrow('root.inner must be an object');
  });
});

describe('ParsedRecord.optionalObject', () => {
  it('returns undefined for missing field', () => {
    const rec = parseObject({}, 'root');
    expect(rec.optionalObject('inner')).toBeUndefined();
  });

  it('returns ParsedRecord when present', () => {
    const rec = parseObject({ inner: { key: 'val' } }, 'root');
    const inner = rec.optionalObject('inner');
    expect(inner?.string('key')).toBe('val');
  });
});

describe('ParsedRecord.raw and keys', () => {
  it('raw returns the underlying value', () => {
    const rec = parseObject({ x: [1, 2, 3] }, 'obj');
    expect(rec.raw('x')).toEqual([1, 2, 3]);
  });

  it('raw returns undefined for missing keys', () => {
    const rec = parseObject({}, 'obj');
    expect(rec.raw('missing')).toBeUndefined();
  });

  it('keys returns all object keys', () => {
    const rec = parseObject({ a: 1, b: 2, c: 3 }, 'obj');
    expect(rec.keys()).toEqual(['a', 'b', 'c']);
  });
});
