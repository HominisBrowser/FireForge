// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type {
  PerPatchExplanation,
  ProjectExplanation,
  TypecheckExplanation,
} from '../../core/typecheck-explain.js';
import { formatTypecheckExplanation } from '../typecheck-explain.js';

function project(overrides: Partial<ProjectExplanation>): ProjectExplanation {
  return {
    project: 'a/jsconfig.json',
    membership: 'root',
    litTypes: false,
    undefinedIdentifiers: 'warning',
    ...overrides,
  };
}

function perPatch(overrides: Partial<PerPatchExplanation>): PerPatchExplanation {
  return {
    enabled: true,
    creators: [],
    modifiers: [],
    program: 'none',
    heads: [],
    resolvable: [],
    imports: [],
    litTypes: false,
    strict: false,
    undefinedIdentifiers: 'warning',
    ...overrides,
  };
}

function explanation(overrides: Partial<TypecheckExplanation>): TypecheckExplanation {
  return {
    file: 'engine/browser/x.sys.mjs',
    exists: true,
    projects: [],
    perPatch: perPatch({}),
    ...overrides,
  };
}

function render(input: TypecheckExplanation): Map<string, string> {
  return new Map(
    formatTypecheckExplanation(input).map(([title, lines]) => [title, lines.join('\n')])
  );
}

describe('formatTypecheckExplanation', () => {
  it('describes every project membership and the source of its extra shim', () => {
    const out = render(
      explanation({
        projects: [
          project({ project: 'root.json', overrideKey: 'root.json', extraShim: 'shim.d.ts' }),
          project({ project: 'other.json', membership: 'not-root', extraShim: 'base.d.ts' }),
          project({ project: 'plain.json', litTypes: true }),
          project({ project: 'off.json', membership: 'skipped' }),
          project({ project: 'bad.json', membership: 'unreadable', detail: 'ENOENT' }),
          project({ project: 'worse.json', membership: 'unreadable' }),
        ],
      })
    ).get('Project pass (typecheck.projects)');
    expect(out).toContain('root.json: checks it as a root.');
    expect(out).toContain('extra shim shim.d.ts (projectOverrides "root.json")');
    expect(out).toContain('other.json: does not list it');
    expect(out).toContain('extra shim base.d.ts (typecheck.extraShim)');
    expect(out).toContain('litTypes on; extra shim none;');
    expect(out).toContain('off.json: sets "checkJs: false"');
    expect(out).toContain('bad.json: cannot be read (ENOENT).');
    expect(out).toContain('worse.json: cannot be read (unknown error).');
  });

  it('says when no projects are configured and when the file is missing', () => {
    const out = render(explanation({ exists: false }));
    expect(out.get('File: engine/browser/x.sys.mjs')).toContain('does not exist');
    expect(out.get('Project pass (typecheck.projects)')).toBe(
      'No typecheck.projects are configured.'
    );
  });

  it('explains a file no per-patch program checks', () => {
    const withReason = render(
      explanation({
        perPatch: perPatch({ modifiers: ['200-a.patch'], reason: 'an upstream file' }),
      })
    ).get('Per-patch checkJs');
    expect(withReason).toContain('Modified by 200-a.patch.');
    expect(withReason).toContain('Not checked per patch: an upstream file.');
    const bare = render(explanation({})).get('Per-patch checkJs');
    expect(bare).toBe('Not checked per patch: no program roots it.');
  });

  it('explains a module root with its imports', () => {
    const out = render(
      explanation({
        perPatch: perPatch({
          creators: ['100-a.patch'],
          program: 'module',
          shim: 'extra.d.ts',
          litTypes: true,
          strict: true,
          resolvable: ['browser/y.sys.mjs'],
          imports: [
            { specifier: 'resource:///modules/y.sys.mjs', resolution: 'owned', target: 'y' },
            { specifier: 'resource:///modules/o.sys.mjs', resolution: 'owned' },
            { specifier: 'chrome://global/content/p.mjs', resolution: 'paths', target: 'p' },
            { specifier: 'chrome://global/content/q.mjs', resolution: 'paths' },
          ],
        }),
      })
    ).get('Per-patch checkJs');
    expect(out).toContain('Created by 100-a.patch.');
    expect(out).toContain('Checked as a root of the queue-wide .sys.mjs program.');
    expect(out).toContain('Shim: built-in Firefox globals + extra.d.ts; litTypes on; strict on;');
    expect(out).toContain('Modules its imports can resolve to (1):\n  browser/y.sys.mjs');
    expect(out).toContain('resource:///modules/y.sys.mjs -> y');
    expect(out).toContain('chrome://global/content/p.mjs -> p (checkJsCompilerOptions.paths)');
    expect(out).not.toContain('An import shown as any');
  });

  it('explains a test script with and without heads', () => {
    const withHeads = render(
      explanation({
        perPatch: perPatch({
          program: 'test',
          heads: ['head.js'],
          imports: [{ specifier: 'resource:///modules/later.sys.mjs', resolution: 'any' }],
        }),
      })
    ).get('Per-patch checkJs');
    expect(withHeads).toContain('Checked as a test script, in its own program.');
    expect(withHeads).toContain('Heads loaded beside it: head.js.');
    expect(withHeads).toContain('Shim: built-in Firefox globals + test harness; litTypes off;');
    expect(withHeads).toContain('Modules its imports can resolve to (0).');
    expect(withHeads).toContain('resource:///modules/later.sys.mjs -> any');
    expect(withHeads).toContain('An import shown as any');
    const noHeads = render(explanation({ perPatch: perPatch({ program: 'test' }) })).get(
      'Per-patch checkJs'
    );
    expect(noHeads).toContain('Heads loaded beside it: none');
    expect(noHeads).toContain('URL imports: none.');
  });
});
