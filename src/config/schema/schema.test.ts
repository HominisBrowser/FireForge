// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describeKeys } from '../../kernel/schema.js';
import { DEFAULT_LICENSE } from './identity.js';
import { configSchema } from './index.js';
import { fileSizeBands, patchSizeBands } from './lint.js';

const MINIMAL = {
  name: 'Mine',
  vendor: 'Example',
  appId: 'org.example.mine',
  binaryName: 'mine',
  firefox: { version: '153.4.0esr', product: 'firefox-esr' },
};

type Doc = Record<string, unknown>;

function issues(document: Doc): string[] {
  const result = configSchema.validate(document);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/** The issues of the minimal document with `patch` merged into the root. */
function issuesWith(patch: Doc): string[] {
  return issues({ ...MINIMAL, ...patch });
}

describe('a realistic configuration', () => {
  it('validates the trimmed configuration of a large source-mode fork', () => {
    const fixture = new URL('../__fixtures__/realistic.fireforge.json', import.meta.url);
    expect(issues(JSON.parse(readFileSync(fixture, 'utf8')) as Doc)).toEqual([]);
  });
});

describe('defaults', () => {
  it('fills the mode and every all-optional section of a minimal document', () => {
    const config = configSchema.parse(MINIMAL);
    expect(config.mode).toBe('patches');
    expect(config.firefox.allowUnverifiedDownload).toBe(false);
    expect(config.test).toEqual({ mochitestPorts: 'fixed' });
    expect(config.patchLint.undefinedIdentifiers).toBe('warning');
    expect(config.check.failOnSkipped).toBe(false);
    expect(config.exportQueue.maxGroupBytes).toBe(1_048_576);
    expect(config.wire.subscriptDir).toBe('browser/base/content');
    expect(config.wire.domTarget).toBe('browser/base/content/browser.xhtml');
    expect(config.license).toBe(DEFAULT_LICENSE);
    expect(DEFAULT_LICENSE).toBe('EUPL-1.2');
    expect(config.gate).toBeUndefined();
    expect(config.source).toBeUndefined();
  });

  it('fills defaults inside a section the document sets partially', () => {
    const config = configSchema.parse({
      ...MINIMAL,
      gate: { lanes: [{ id: 'a', files: ['x/browser_a.js'] }] },
    });
    expect(config.gate?.build).toBe('ui');
    expect(config.gate?.lanes?.[0]).toEqual({
      id: 'a',
      files: ['x/browser_a.js'],
      dispatch: 'shards',
      headed: false,
      uploadDir: false,
    });
  });
});

describe('every key', () => {
  it('carries a description for config help and the documentation', () => {
    const undocumented = describeKeys(configSchema)
      .filter((key) => key.doc === undefined)
      .map((key) => key.path);
    expect(undocumented).toEqual([]);
  });
});

describe('unknown keys', () => {
  it.each([
    [{ patchLint: { rule: {} } }, 'patchLint.rule: is not a known key. Did you mean "rules"?'],
    [{ sources: {} }, 'sources: is not a known key. Did you mean "source"?'],
    [{ slots: {} }, 'slots: is not a known key.'],
    [{ proof: {} }, 'proof: is not a known key.'],
    [
      { check: { extraSteps: [{ name: 'a', command: ['b'], footprint: { static: true } }] } },
      'check.extraSteps[0].footprint: is not a known key.',
    ],
    [{ test: { lockMode: 'shared' } }, 'test.lockMode: is not a known key.'],
  ])('refuses %j', (patch, expected) => {
    expect(issuesWith(patch)).toEqual([expected]);
  });
});

describe('identity', () => {
  it.each([
    [{ binaryName: '../evil' }, 'binaryName'],
    [{ binaryName: 'My Browser' }, 'binaryName'],
    [{ binaryName: '/usr/bin/x' }, 'binaryName'],
    [{ appId: 'browser' }, 'appId'],
    [{ name: '   ' }, 'name'],
    [{ vendor: 'a\u0007b' }, 'vendor'],
    [{ license: 'MIT' }, 'license'],
    [{ markerComment: ' X' }, 'markerComment'],
    [{ markerComment: 'X */' }, 'markerComment'],
    [{ markerComment: 'a\nb' }, 'markerComment'],
  ])('refuses %j', (patch, key) => {
    expect(issuesWith(patch)).toEqual([
      expect.stringMatching(new RegExp(`^${key}: must be`)) as string,
    ]);
  });

  it('accepts a marker and a supported license', () => {
    expect(issuesWith({ markerComment: 'MYBROWSER', license: 'MPL-2.0' })).toEqual([]);
  });
});

describe('firefox', () => {
  const firefox = (fields: Doc): string[] =>
    issuesWith({ firefox: { ...MINIMAL.firefox, ...fields } });

  it.each([
    [{ version: '147.0b1', product: 'firefox-devedition' }],
    [{ version: '147.0b2', product: 'firefox-beta' }],
    [{ version: '146.0.1', product: 'firefox' }],
    [{ sha256: 'a'.repeat(64), candidate: 'build2', allowUnverifiedDownload: true }],
  ])('accepts %j', (fields) => {
    expect(firefox(fields)).toEqual([]);
  });

  it.each([
    [{ version: 'latest' }, 'firefox.version: must be a Firefox version'],
    [
      { version: '153.0', product: 'firefox-esr' },
      'firefox: must pair product firefox-esr with an ESR version',
    ],
    [
      { version: '146.0', product: 'firefox-devedition' },
      'firefox: must pair product firefox-devedition with a beta',
    ],
    [{ version: '153.0esr', product: 'firefox' }, 'firefox: must use product firefox-esr'],
    [{ product: 'nightly' }, 'firefox.product: must be one of'],
    [{ sha256: 'A'.repeat(64) }, 'firefox.sha256: must be a lowercase 64-character'],
    [{ candidate: 'build0' }, 'firefox.candidate: must be a candidate directory'],
  ])('refuses %j', (fields, expected) => {
    expect(firefox(fields)).toEqual([expect.stringContaining(expected) as string]);
  });
});

describe('mode and source', () => {
  const source = {
    root: 'src',
    metadataRoot: '.fireforge-sources',
    pristineCommit: 'a'.repeat(40),
  };

  it('accepts source mode with its block', () => {
    expect(issuesWith({ mode: 'source', source })).toEqual([]);
  });

  it.each([
    [{ mode: 'source' }, ': needs a "source" block when "mode" is "source"'],
    [{ source }, ': has a "source" block, which applies only when "mode" is "source"'],
    [
      { mode: 'source', source: { ...source, root: 'engine/src' } },
      'source.root: must not be inside the reserved "engine" directory',
    ],
    [
      { mode: 'source', source: { ...source, root: 'Patches' } },
      'source.root: must not be inside the reserved "patches" directory',
    ],
    [
      { mode: 'source', source: { ...source, root: '../src' } },
      'source.root: must be a canonical relative directory inside the project',
    ],
    [
      { mode: 'source', source: { ...source, root: 'src/' } },
      'source.root: must be a canonical relative directory inside the project',
    ],
    [
      { mode: 'source', source: { ...source, root: 'a/.git/b' } },
      'source.root: must be a canonical relative directory inside the project',
    ],
    [
      { mode: 'source', source: { ...source, metadataRoot: 'src/meta' } },
      'source: must keep root and metadataRoot apart: neither may contain the other',
    ],
    [
      { mode: 'source', source: { ...source, pristineCommit: 'abc' } },
      'source.pristineCommit: must be a complete lowercase Git object ID (got "abc")',
    ],
  ])('refuses %j', (patch, expected) => {
    expect(issuesWith(patch)).toEqual([expected]);
  });

  it('does not tie source mode to any test setting', () => {
    expect(issuesWith({ mode: 'source', source, test: { mochitestPorts: 'auto' } })).toEqual([]);
  });
});

describe('patchLint', () => {
  const lint = (fields: Doc): string[] => issuesWith({ patchLint: fields });

  it.each([
    [{ checkJsStrict: true }, 'patchLint: sets checkJsStrict, which needs checkJs: true'],
    [
      { checkJs: true, checkJsCompilerOptions: {} },
      'patchLint: sets checkJsCompilerOptions, which needs checkJsStrict: true',
    ],
    [{ checkJsTestFiles: true }, 'patchLint: sets checkJsTestFiles, which needs checkJs: true'],
    [
      { checkJs: true, checkJsTestShim: 'x.d.ts' },
      'patchLint: sets checkJsTestShim, which needs checkJsTestFiles: true',
    ],
    [{ litTypes: true }, 'patchLint: sets litTypes, which needs checkJs: true'],
    [
      { checkJsExtraShim: '/abs/x.d.ts' },
      'patchLint.checkJsExtraShim: must be a project-relative path inside the project',
    ],
    [
      { checkJsExtraShim: '../x.d.ts' },
      'patchLint.checkJsExtraShim: must be a project-relative path inside the project',
    ],
    [
      { checkJs: true, checkJsStrict: true, checkJsCompilerOptions: { strict: false } },
      'patchLint.checkJsCompilerOptions.strict: is not a known key.',
    ],
    [
      { checkJs: true, checkJsStrict: true, checkJsCompilerOptions: { paths: { 'a/*/*': ['x'] } } },
      'patchLint.checkJsCompilerOptions.paths["a/*/*"]: must be a pattern with at most one "*" (got "a/*/*")',
    ],
    [
      { rules: { 'missing-jsdoc': 'error' } },
      expect.stringContaining('patchLint.rules.missing-jsdoc: must be one of: relative-import,'),
    ],
    [
      { rules: { jsdoc: 'loud' } },
      'patchLint.rules.jsdoc: must be one of: off, notice, warning, error (got "loud")',
    ],
  ])('refuses %j', (fields, expected) => {
    expect(lint(fields)).toEqual([expected]);
  });

  it('accepts the strict preset with overrides and a paths mapping', () => {
    const options = { strictNullChecks: false, paths: { 'resource:///modules/x/*': ['./*'] } };
    expect(lint({ checkJs: true, checkJsStrict: true, checkJsCompilerOptions: options })).toEqual(
      []
    );
  });

  it('checks size overrides against the bands they resolve to', () => {
    expect(lint({ fileSizeThresholds: { general: { warning: 800 } } })).toEqual([]);
    expect(lint({ fileSizeThresholds: { general: { warning: 400 } } })).toEqual([
      'patchLint.fileSizeThresholds.general: must resolve to notice <= warning <= error (resolved: 500/400/900)',
    ]);
    expect(lint({ patchSizeThresholds: { branding: { files: { error: 50 } } } })).toEqual([
      'patchLint.patchSizeThresholds.branding: files must resolve to notice <= warning <= error (resolved: 60/60/50)',
    ]);
    expect(lint({ fileSizeThresholds: { general: { notice: 0 } } })).toEqual([
      'patchLint.fileSizeThresholds.general.notice: must be an integer of at least 1 (got 0)',
    ]);
  });

  it('resolves bands by merging overrides over the defaults', () => {
    expect(fileSizeBands('test', { warning: 1500 })).toEqual({
      notice: 1200,
      warning: 1500,
      error: 1600,
    });
    expect(patchSizeBands('general')).toEqual({
      lines: { notice: 800, warning: 1500, error: 3000 },
      files: { notice: 5, warning: 5, error: null },
    });
    expect(patchSizeBands('branding', { files: { warning: 70 } }).files).toEqual({
      notice: 70,
      warning: 70,
      error: null,
    });
  });

  it('validates token scales', () => {
    const scale = { properties: ['gap', 'padding*'], prefix: '--x-space-' };
    expect(lint({ tokenScales: [scale] })).toEqual([]);
    expect(lint({ tokenScales: [{ ...scale, prefix: 'x-space-' }] })).toEqual([
      'patchLint.tokenScales[0].prefix: must be a custom-property prefix such as "--brand-space-", or an array of a custom-property prefix such as "--brand-space-" (got "x-space-")',
    ]);
    expect(lint({ tokenScales: [{ ...scale, allow: ['brand-x'] }] })).toEqual([
      'patchLint.tokenScales[0].allow[0]: must be a custom-property name starting with "--" (got "brand-x")',
    ]);
    expect(lint({ tokenScales: [{ ...scale, properties: [] }] })).toEqual([
      'patchLint.tokenScales[0].properties: must have a length of at least 1 (got 0)',
    ]);
    expect(
      lint({
        tokenScales: [
          { ...scale, allowValues: [{ property: 'Padding-Top', value: '3px', reason: 'r' }] },
        ],
      })
    ).toEqual([]);
    expect(
      lint({
        tokenScales: [
          { ...scale, allowValues: [{ property: 'color', value: 'red', reason: 'r' }] },
        ],
      })
    ).toEqual([
      'patchLint.tokenScales[0]: allows a value for "color", which is not a property this scale governs',
    ]);
    expect(lint({ tokenScales: [{ ...scale, minFiles: 0 }] })).toEqual([
      'patchLint.tokenScales[0].minFiles: must be an integer of at least 1 (got 0)',
    ]);
  });
});

describe('patchPolicy', () => {
  const ranges = [{ from: 1, to: 99, category: 'branding' }];
  const policy = (fields: Doc): string[] => issuesWith({ patchPolicy: { ranges, ...fields } });

  it('accepts the registration-only rules', () => {
    expect(
      policy({
        addOnlyMarker: 'brand',
        upstreamAllowlist: [
          'browser/moz.configure',
          { path: '**/jar.mn', addOnly: true, retiredPaths: ['a.svg'] },
        ],
        scopeRules: [{ group: '-tests\\.patch$', files: ['**/test/**'] }],
        reservedRanges: [
          { from: 900, to: 999, allowed: [{ filename: '900-x.patch', adr: 'docs/adr/1.md' }] },
        ],
        verifyDocumentPaths: true,
      })
    ).toEqual([]);
  });

  it.each([
    [{ ranges: [] }, 'patchPolicy.ranges: must have a length of at least 1 (got 0)'],
    [
      { ranges: [...ranges, { from: 50, to: 120, category: 'ui' }] },
      'patchPolicy.ranges: must not overlap (1-99 overlaps 50-120)',
    ],
    [
      { ranges: [{ from: 9, to: 5, category: 'ui' }] },
      'patchPolicy.ranges[0]: must have "to" (5) at or above "from" (9)',
    ],
    [
      { ranges: [{ from: 1, to: 5, category: 'UI' }] },
      'patchPolicy.ranges[0].category: must be a lowercase category identifier (letters, digits, hyphens) (got "UI")',
    ],
    [{ filenamePattern: '(' }, 'patchPolicy.filenamePattern: must be a valid regular expression'],
    [
      { upstreamAllowlist: [{ path: 'a', addOnly: true }] },
      'patchPolicy: sets addOnly on upstreamAllowlist[0] without a marker: set its marker or addOnlyMarker',
    ],
    [
      { upstreamAllowlist: [{ path: 'a', retiredPaths: ['b'] }] },
      'patchPolicy: sets retiredPaths on upstreamAllowlist[0], which applies only with addOnly: true',
    ],
    [{ scopeRules: [{ files: ['a/**'] }] }, 'patchPolicy.scopeRules[0].group: is required'],
    [
      { reservedRanges: [{ from: 1, to: 2, allowed: [{ filename: 'x', adr: '../adr.md' }] }] },
      'patchPolicy.reservedRanges[0].allowed[0].adr: must be a project-relative path inside the project',
    ],
  ])('refuses %j', (fields, expected) => {
    expect(policy(fields)).toEqual([expect.stringContaining(expected) as string]);
  });
});

describe('typecheck', () => {
  it('accepts overrides keyed by a declared project, including null', () => {
    expect(
      issuesWith({
        typecheck: {
          projects: ['a/jsconfig.json', 'b/jsconfig.json'],
          projectOverrides: { 'a/jsconfig.json': null, 'b/jsconfig.json': 'x.d.ts' },
        },
      })
    ).toEqual([]);
  });

  it.each([
    [{ projects: [] }, 'typecheck.projects: must have a length of at least 1 (got 0)'],
    [{}, 'typecheck.projects: is required'],
    [
      { projects: ['a.json'], projectOverrides: { 'b.json': null } },
      'typecheck: overrides "b.json", which is not one of its projects',
    ],
    [
      { projects: ['/abs.json'] },
      'typecheck.projects[0]: must be a project-relative path inside the project',
    ],
  ])('refuses %j', (fields, expected) => {
    expect(issuesWith({ typecheck: fields })).toEqual([expected]);
  });
});

describe('check', () => {
  const check = (fields: Doc): string[] => issuesWith({ check: fields });

  it('accepts steps ordered after built-in and extra steps', () => {
    expect(
      check({
        skip: ['token-coverage', 'token-lint'],
        status: { failOn: ['unmanaged'], allow: ['unapplied'] },
        minTokenCoverage: 80,
        extraSteps: [
          { name: 'a', command: ['node', 'x.mjs'], after: ['typecheck'] },
          { name: 'b', command: ['tools/y'], after: ['a'], engine: true, timeout: 30 },
        ],
      })
    ).toEqual([]);
  });

  it.each([
    [{ skip: ['nope'] }, 'check.skip[0]: must be one of'],
    [{ timeout: 5 }, 'check.timeout: is not a known key.'],
    [
      { extraSteps: [{ name: 'a', command: 'node x.mjs' }] },
      'check.extraSteps[0].command: must be an array',
    ],
    [
      { extraSteps: [{ name: 'a', command: ['x'], timeout: 0 }] },
      'check.extraSteps[0].timeout: must be an integer of at least 1 (got 0)',
    ],
    [{ minTokenCoverage: 101 }, 'check.minTokenCoverage: must be an integer'],
    [
      { extraSteps: [{ name: 'lint', command: ['x'] }] },
      'check.extraSteps[0].name: must not reuse the built-in step "lint"',
    ],
    [
      { extraSteps: [{ name: 'Policy', command: ['x'] }] },
      'check.extraSteps[0].name: must be lowercase letters',
    ],
    [
      {
        extraSteps: [
          { name: 'a', command: ['x'] },
          { name: 'a', command: ['y'] },
        ],
      },
      'check.extraSteps: repeats the step name "a"',
    ],
    [
      { extraSteps: [{ name: 'a', command: ['x'], after: ['zzz'] }] },
      'check.extraSteps: orders step "a" after unknown step "zzz"',
    ],
    [
      { extraSteps: [{ name: 'a', command: ['x'], after: ['a'] }] },
      'check.extraSteps: orders step "a" after itself',
    ],
    [
      {
        extraSteps: [
          { name: 'a', command: ['x'], after: ['b'] },
          { name: 'b', command: ['y'], after: ['a'] },
        ],
      },
      'check.extraSteps: orders its steps in a cycle: a -> b -> a',
    ],
    [{ lintReport: '../out.json' }, 'check.lintReport: must be a project-relative path'],
  ])('refuses %j', (fields, expected) => {
    expect(check(fields)).toEqual([expect.stringContaining(expected) as string]);
  });
});

describe('gate', () => {
  const lane = { id: 'tiles', files: ['browser/tiles/test/browser_*.js'] };
  const gate = (fields: Doc): string[] => issuesWith({ gate: fields });

  it('accepts lanes, stress, controls, runs and acceptance that reference them', () => {
    expect(
      gate({
        build: 'full',
        documents: ['docs/**', '*.md'],
        lanes: [
          {
            ...lane,
            dispatch: 'one-browser',
            env: { BRAND_DIR: '{artifacts}/x' },
            uploadDir: true,
          },
        ],
        stress: [{ ...lane, repeat: 10 }],
        controls: [
          {
            id: 'guard',
            diff: 'tools/guard.diff',
            test: 'browser/a/browser_a.js',
            assertions: ['holds'],
          },
        ],
        runs: [{ id: 'smoke', smokeExit: 30, consoleAllowFile: 'tools/allow.txt' }],
        acceptance: [
          { id: 'scene', reason: 'A person looks.', evidence: ['lane:tiles', 'run:smoke'] },
        ],
      })
    ).toEqual([]);
  });

  it.each([
    [{ lanes: [lane, lane] }, 'gate.lanes: repeats the lane ID "tiles"'],
    [{ lanes: [{ ...lane, id: 'Tiles' }] }, 'gate.lanes[0].id: must be a lowercase ID'],
    [
      { lanes: [{ ...lane, files: [] }] },
      'gate.lanes[0].files: must have a length of at least 1 (got 0)',
    ],
    [{ lanes: [{ ...lane, quiet: true }] }, 'gate.lanes[0].quiet: is not a known key.'],
    [{ lanes: [{ ...lane, owns: ['a/**'] }] }, 'gate.lanes[0].owns: is not a known key.'],
    [{ runs: [{ id: 'smoke' }] }, 'gate.runs[0].smokeExit: is required'],
    [{ mode: 'debug' }, 'gate.mode: is not a known key.'],
    [{ documents: [] }, 'gate.documents: must have a length of at least 1 (got 0)'],
    [
      { lanes: [{ ...lane, env: { PATH: '/bin' } }] },
      'gate.lanes[0].env: sets PATH, which FireForge owns',
    ],
    [
      { lanes: [{ ...lane, env: { MOZ_UPLOAD_DIR: 'x' } }] },
      'gate.lanes[0].env: sets MOZ_UPLOAD_DIR, which FireForge owns; set uploadDir instead',
    ],
    [
      { lanes: [{ ...lane, env: { lower: 'x' } }] },
      'gate.lanes[0].env: names lower: names are upper case',
    ],
    [
      { lanes: [{ ...lane, env: { BRAND: '/etc/passwd' } }] },
      'gate.lanes[0].env: sets BRAND to a path outside the run',
    ],
    [
      { lanes: [{ ...lane, env: { BRAND: 'a\nb' } }] },
      'gate.lanes[0].env: sets BRAND to more than one line',
    ],
    [
      { lanes: [{ ...lane, machArgs: ['--setpref=marionette.port=1'] }] },
      'gate.lanes[0].machArgs[0]: must not set a marionette.* pref',
    ],
    [
      { lanes: [{ ...lane, machArgs: ['--setpref=a.b=/tmp'] }] },
      'gate.lanes[0].machArgs[0]: must be --setpref=<name>=<value>',
    ],
    [{ lanes: [{ ...lane, args: ['--repeat=3'] }] }, 'gate.lanes[0].args: is not a known key.'],
    [
      { lanes: [{ ...lane, validate: { command: ['python3', 'x.py'] } }] },
      'gate.lanes[0].validate: must run node or a committed script by its path',
    ],
    [
      { lanes: [{ ...lane, validate: { command: ['node', '--eval', 'x'] } }] },
      'gate.lanes[0].validate: must run node on a committed script',
    ],
    [
      { lanes: [{ ...lane, validate: { command: ['node', '../x.mjs'] } }] },
      'gate.lanes[0].validate: must name no path outside the workspace',
    ],
    [
      { lanes: [{ ...lane, validate: { command: ['node', 'x.mjs'], footprint: { cpu: 2 } } }] },
      'gate.lanes[0].validate.footprint: is not a known key.',
    ],
    [
      { stress: [{ ...lane, repeat: 0 }] },
      'gate.stress[0].repeat: must be an integer of at least 1 (got 0)',
    ],
    [
      { acceptance: [{ id: 'a', reason: 'r', evidence: ['lane:nope'] }] },
      'gate: has acceptance "a" naming lane:nope, which the gate does not declare',
    ],
    [
      { acceptance: [{ id: 'a', reason: 'r', evidence: ['tiles'] }] },
      'gate.acceptance[0].evidence[0]: must be kind:id',
    ],
    [{ check: { quiet: true } }, 'gate.check: is not a known key.'],
    [{ noneRoutes: ['tools/**'] }, 'gate.noneRoutes: is not a known key.'],
    [{ consumerLimit: 3 }, 'gate.consumerLimit: is not a known key.'],
  ])('refuses %j', (fields, expected) => {
    expect(gate(fields)).toEqual([expect.stringContaining(expected) as string]);
  });
});

describe('other sections', () => {
  it.each([
    [
      {
        exportQueue: {
          groups: [
            { name: 'ui-a', paths: ['a/**'] },
            { name: 'ui-a', paths: ['b'] },
          ],
        },
      },
      'exportQueue.groups: repeats the group name "ui-a"',
    ],
    [
      { exportQueue: { groups: [{ name: 'UI', paths: ['a'] }] } },
      'exportQueue.groups[0].name: must be lowercase words',
    ],
    [
      { buildAudit: { unpackaged: [{ path: 'a/**', reason: 'r' }] } },
      'buildAudit.unpackaged[0].path: must not use "**"',
    ],
    [
      { buildAudit: { unpackaged: [{ path: 'a', reason: ' ' }] } },
      'buildAudit.unpackaged[0].reason: must be a non-empty string',
    ],
    [
      {
        buildAudit: {
          unpackaged: [
            { path: 'a', reason: 'r' },
            { path: 'a', reason: 's' },
          ],
        },
      },
      'buildAudit.unpackaged: repeats the path "a"',
    ],
    [{ build: { jobs: 0 } }, 'build.jobs: must be an integer of at least 1 (got 0)'],
    [
      { build: { release: { overlay: 'c/r.mozconfig', outputs: ['dist/*/x'] } } },
      'build.release.outputs[0]: must be a canonical path',
    ],
    [
      {
        build: { release: { overlay: 'c/r.mozconfig', secrets: { variable: 'lower', files: [] } } },
      },
      'build.release.secrets.variable: must be an environment variable name',
    ],
    [
      { test: { harnessFailurePatterns: ['(unclosed'] } },
      'test.harnessFailurePatterns[0]: must be a valid regular expression',
    ],
    [
      { externalToolchains: [{ name: 'x', tools: [] }] },
      'externalToolchains[0].tools: must have a length of at least 1 (got 0)',
    ],
    [
      { wire: { subscriptDir: '/abs' } },
      'wire.subscriptDir: must be an engine-relative path inside the engine',
    ],
    [
      { patchPolicy: { ranges: [{ from: 1, to: 9, category: 'ui' }], mutationMode: 'force' } },
      'patchPolicy.mutationMode',
    ],
    [{ history: { path: '.fireforge/history.jsonl' } }, 'history'],
  ])('refuses %j', (patch, expected) => {
    expect(issuesWith(patch)).toEqual([expect.stringContaining(expected) as string]);
  });
});
