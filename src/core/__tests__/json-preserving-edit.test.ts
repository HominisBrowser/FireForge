// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../../types/json.js';
import { rewriteJsonPreservingFormat } from '../json-preserving-edit.js';

const COMPACT = `{
  "name": "x",
  "firefox": { "version": "153.3.0esr", "product": "firefox-esr" },
  "patchLint": { "rawColorAllowlist": ["a.css", "b.css"], "fileSizeThresholds": { "a": 1, "b": 2 } },
  "externalToolchains": [1, 2, 3]
}
`;

function parsed(text: string): JsonObject {
  return JSON.parse(text) as JsonObject;
}

function rewrite(text: string, mutate: (doc: JsonObject) => void): string | undefined {
  const doc = parsed(text);
  mutate(doc);
  return rewriteJsonPreservingFormat(text, doc);
}

describe('rewriteJsonPreservingFormat', () => {
  it('returns the text unchanged when nothing differs', () => {
    expect(rewriteJsonPreservingFormat(COMPACT, parsed(COMPACT))).toBe(COMPACT);
  });

  it('replaces a primitive in a one-line object without touching other sections', () => {
    const result = rewrite(COMPACT, (doc) => {
      (doc['firefox'] as JsonObject)['version'] = '153.4.0esr';
    });
    expect(result).toBe(COMPACT.replace('153.3.0esr', '153.4.0esr'));
  });

  it('inserts and removes keys in a one-line object on its own line', () => {
    const result = rewrite(COMPACT, (doc) => {
      const firefox = doc['firefox'] as JsonObject;
      firefox['sha256'] = 'abc';
      delete firefox['product'];
    });
    expect(result).toBe(
      COMPACT.replace(
        '{ "version": "153.3.0esr", "product": "firefox-esr" }',
        '{ "version": "153.3.0esr", "sha256": "abc" }'
      )
    );
  });

  it('appends to a one-line array inline', () => {
    const result = rewrite(COMPACT, (doc) => {
      const patchLint = doc['patchLint'] as JsonObject;
      patchLint['rawColorAllowlist'] = ['a.css', 'b.css', 'c.css'];
    });
    expect(result).toBe(COMPACT.replace('"b.css"]', '"b.css", "c.css"]'));
  });

  it('keeps a replaced container in its original shape', () => {
    const result = rewrite(COMPACT, (doc) => {
      doc['externalToolchains'] = [9];
      (doc['patchLint'] as JsonObject)['fileSizeThresholds'] = { c: 3 };
    });
    expect(result).toBe(
      COMPACT.replace('[1, 2, 3]', '[9]').replace('{ "a": 1, "b": 2 }', '{ "c": 3 }')
    );
  });

  it('edits array elements in place when the length is unchanged', () => {
    const result = rewrite(COMPACT, (doc) => {
      doc['externalToolchains'] = [1, 5, 3];
    });
    expect(result).toBe(COMPACT.replace('[1, 2, 3]', '[1, 5, 3]'));
  });

  it('inserts new top-level keys with the document indentation', () => {
    const result = rewrite(COMPACT, (doc) => {
      doc['wire'] = { subscriptDir: 'a', list: [1] };
    });
    expect(result).toBe(
      COMPACT.replace(
        '"externalToolchains": [1, 2, 3]\n',
        '"externalToolchains": [1, 2, 3],\n  "wire": {\n    "subscriptDir": "a",\n    "list": [\n      1\n    ]\n  }\n'
      )
    );
  });

  it('opens empty containers following the parent layout', () => {
    const text = '{\n  "a": {},\n  "b": [],\n  "c": { "d": {}, "e": [] }\n}\n';
    const result = rewrite(text, (doc) => {
      (doc['a'] as JsonObject)['k'] = 1;
      doc['b'] = ['x'];
      const c = doc['c'] as JsonObject;
      (c['d'] as JsonObject)['k'] = 2;
      c['e'] = ['y'];
    });
    expect(result).toBe(
      '{\n  "a": {\n    "k": 1\n  },\n  "b": [\n    "x"\n  ],\n  "c": { "d": { "k": 2 }, "e": ["y"] }\n}\n'
    );
  });

  it('detects tab indentation and CRLF line endings', () => {
    const text = '{\r\n\t"a": 1\r\n}\r\n';
    const result = rewrite(text, (doc) => {
      doc['b'] = { c: true };
    });
    expect(result).toBe('{\r\n\t"a": 1,\r\n\t"b": {\r\n\t\t"c": true\r\n\t}\r\n}\r\n');
  });

  it('replaces a primitive with a container laid out like its parent', () => {
    const result = rewrite('{\n  "a": 1\n}\n', (doc) => {
      doc['a'] = { b: [] };
    });
    expect(result).toBe('{\n  "a": {\n    "b": []\n  }\n}\n');
  });

  it('removes keys from a multi-line object cleanly', () => {
    const result = rewrite('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n', (doc) => {
      delete doc['b'];
      delete doc['c'];
    });
    expect(result).toBe('{\n  "a": 1\n}\n');
  });

  it('treats undefined values as absent keys', () => {
    const doc = parsed(COMPACT);
    (doc['firefox'] as JsonObject)['sha256'] = undefined;
    expect(rewriteJsonPreservingFormat(COMPACT, doc)).toBe(COMPACT);
  });

  it('returns undefined for text that is not a JSON object', () => {
    expect(rewriteJsonPreservingFormat('not json', {})).toBeUndefined();
    expect(rewriteJsonPreservingFormat('[1]', {})).toBeUndefined();
  });

  it('defaults to two-space indentation for a one-line document', () => {
    expect(rewrite('{}', (doc) => (doc['a'] = 1))).toBe('{ "a": 1 }');
  });
});
