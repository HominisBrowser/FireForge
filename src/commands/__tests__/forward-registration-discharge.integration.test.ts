// SPDX-License-Identifier: EUPL-1.2
/**
 * The `forward-registration` remedy must actually discharge the finding.
 *
 * The rule prints a paste-and-run `patch staged-dependency --add --kind
 * registration` command, and the arm that VALIDATES the resulting
 * declaration compares `--line` against the lines the patch ADDS. A
 * synthesised `support-files = ["<entry>"]` only ever matched a manifest
 * whose array is single-line and single-entry, so on a real queue the
 * pasted command traded one error for a `staged-dependency-unused`
 * warning on the same patch. These tests drive the printed command through
 * the real command implementation, on a real patches directory, for each
 * manifest shape a Firefox tree actually uses — that end-to-end path is the
 * only place the two arms' disagreement is visible.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPatchQueueContext, lintPatchQueue } from '../../core/patch-lint.js';
import {
  createTempProject,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type {
  PatchesManifest,
  PatchLintIssue,
  PatchMetadata,
  PatchStagedRegistration,
} from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { patchStagedDependencyCommand } from '../patch/staged-dependency.js';

/** A `new file mode` diff creating `path` with `lines` as its content. */
function createFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

const ALPHA_MANIFEST = 'browser/alpha/test/xpcshell.toml';
const BETA_MANIFEST = 'browser/beta/test/browser.toml';
const GAMMA_MANIFEST = 'browser/gamma/test/browser.toml';

/** (a) single-line, single-entry array — the only shape the old remedy fit. */
const ALPHA_LINES = ['[DEFAULT]', 'support-files = ["file_alpha.html"]', '', '["test_alpha.js"]'];
/** (b) array spread over several lines, one entry per line. */
const BETA_LINES = [
  '[DEFAULT]',
  'support-files = [',
  '  "file_beta_one.html",',
  '  "file_beta_two.html",',
  ']',
  '',
  '["browser_beta.js"]',
];
/** (c) two-entry one-liner inside a per-test section. */
const GAMMA_LINES = [
  '[DEFAULT]',
  '',
  '["browser_gamma.js"]',
  'support-files = ["file_gamma_a.html", "file_gamma_b.html"]',
];

/** Every file the manifests above register, created by the last patch. */
const FIXTURES = [
  'browser/alpha/test/file_alpha.html',
  'browser/beta/test/file_beta_one.html',
  'browser/beta/test/file_beta_two.html',
  'browser/gamma/test/file_gamma_a.html',
  'browser/gamma/test/file_gamma_b.html',
];

const BODIES: Record<string, string> = {
  '102-ui-alpha.patch': createFileDiff(ALPHA_MANIFEST, ALPHA_LINES),
  '111-ui-beta.patch': createFileDiff(BETA_MANIFEST, BETA_LINES),
  '201-ui-gamma.patch': createFileDiff(GAMMA_MANIFEST, GAMMA_LINES),
  '301-ui-fixtures.patch': FIXTURES.map((path) => createFileDiff(path, ['<!doctype html>'])).join(
    ''
  ),
};

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-09-05T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

const PATCHES: PatchMetadata[] = [
  makeMetadata('102-ui-alpha.patch', 102, [ALPHA_MANIFEST]),
  makeMetadata('111-ui-beta.patch', 111, [BETA_MANIFEST]),
  makeMetadata('201-ui-gamma.patch', 201, [GAMMA_MANIFEST]),
  makeMetadata('301-ui-fixtures.patch', 301, [...FIXTURES]),
];

/**
 * Splits a printed command into argv the way a POSIX shell would: bare
 * words on whitespace, and a double-quoted run with `\"`/`\\` unescaped.
 * The rule quotes `--line` for the shell, so anything less than this would
 * test a string the operator never actually pastes.
 */
function shellSplit(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!quoted && ch !== undefined && /\s/.test(ch)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    started = true;
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === '\\' && quoted) {
      i += 1;
      current += command[i] ?? '';
      continue;
    }
    current += ch ?? '';
  }
  if (started) argv.push(current);
  return argv;
}

/** The flag values of a `fireforge patch staged-dependency …` command. */
interface DischargeCommand {
  patch: string;
  mode: 'add' | 'remove';
  file: string;
  line: string;
  creates: string;
  owner?: string;
}

/**
 * Extracts the `patch staged-dependency` command a lint message prints and
 * shell-splits it, so the test applies exactly what the operator pastes.
 */
function parseDischargeCommand(message: string): DischargeCommand {
  const start = message.indexOf('fireforge patch staged-dependency ');
  expect(start).toBeGreaterThanOrEqual(0);
  // The remedy is the tail of the message; the unused-warning form ends the
  // sentence with `; or update it…`, which is not part of the command.
  const tail = message.slice(start).split('; or ')[0] ?? '';
  const argv = shellSplit(tail);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const patch = argv[3];
  const file = flag('--file');
  const line = flag('--line');
  const creates = flag('--creates');
  const owner = flag('--owner');
  expect({ patch, file, line, creates }).not.toHaveProperty('patch', undefined);
  return {
    patch: patch ?? '',
    mode: argv.includes('--remove') ? 'remove' : 'add',
    file: file ?? '',
    line: line ?? '',
    creates: creates ?? '',
    ...(owner === undefined ? {} : { owner }),
  };
}

describe('forward-registration discharge', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-fwreg-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    for (const patch of PATCHES) {
      await writeFile(join(patchesDir, patch.filename), BODIES[patch.filename] ?? '');
    }
    await writeFile(
      join(patchesDir, 'patches.json'),
      JSON.stringify({ version: 1, patches: PATCHES } satisfies PatchesManifest, null, 2)
    );
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  const lint = async (): Promise<PatchLintIssue[]> =>
    lintPatchQueue(await buildPatchQueueContext(patchesDir));

  const findings = (issues: PatchLintIssue[], check: string): PatchLintIssue[] =>
    issues.filter((issue) => issue.check === check);

  const loadRegistrations = async (
    filename: string
  ): Promise<readonly PatchStagedRegistration[]> => {
    const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
    const manifest = JSON.parse(raw) as PatchesManifest;
    return (
      manifest.patches.find((p) => p.filename === filename)?.stagedDependencies?.registrations ?? []
    );
  };

  const apply = async (command: DischargeCommand): Promise<void> => {
    await patchStagedDependencyCommand(projectRoot, command.patch, {
      ...(command.mode === 'add' ? { add: true } : { remove: true }),
      kind: 'registration',
      file: command.file,
      line: command.line,
      creates: command.creates,
      ...(command.owner === undefined ? {} : { owner: command.owner }),
    });
  };

  it('quotes --line as the patch adds it, in every manifest shape', async () => {
    const issues = findings(await lint(), 'forward-registration');
    // One per registered fixture: 1 from alpha, 2 from beta, 2 from gamma.
    expect(issues).toHaveLength(5);

    const byCreates = new Map(
      issues.map((issue) => [
        parseDischargeCommand(issue.message).creates,
        parseDischargeCommand(issue.message).line,
      ])
    );
    expect(byCreates.get('browser/alpha/test/file_alpha.html')).toBe(
      'support-files = ["file_alpha.html"]'
    );
    // The multi-line array element, NOT a synthesised single-entry array.
    expect(byCreates.get('browser/beta/test/file_beta_one.html')).toBe('"file_beta_one.html",');
    expect(byCreates.get('browser/beta/test/file_beta_two.html')).toBe('"file_beta_two.html",');
    // The whole one-liner, for both entries it lists.
    expect(byCreates.get('browser/gamma/test/file_gamma_a.html')).toBe(
      'support-files = ["file_gamma_a.html", "file_gamma_b.html"]'
    );
    expect(byCreates.get('browser/gamma/test/file_gamma_b.html')).toBe(
      'support-files = ["file_gamma_a.html", "file_gamma_b.html"]'
    );
  });

  it('the printed command silences BOTH arms on the next lint', async () => {
    for (const issue of findings(await lint(), 'forward-registration')) {
      await apply(parseDischargeCommand(issue.message));
    }

    const after = await lint();
    expect(findings(after, 'forward-registration')).toEqual([]);
    // The regression this fixes: discharging used to trade the error for a
    // warning on the very patch the remedy told the operator to edit.
    expect(findings(after, 'staged-dependency-unused')).toEqual([]);
  });

  it('negative control: the pre-fix synthesised line is reported unused', async () => {
    // What the rule printed before the fix, for the multi-line array.
    await patchStagedDependencyCommand(projectRoot, '111-ui-beta.patch', {
      add: true,
      kind: 'registration',
      file: BETA_MANIFEST,
      line: 'support-files = ["file_beta_one.html"]',
      creates: 'browser/beta/test/file_beta_one.html',
      owner: '301-ui-fixtures.patch',
    });

    const unused = findings(await lint(), 'staged-dependency-unused');
    expect(unused).toHaveLength(1);
    expect(unused[0]?.message).toContain('the patch does not add that line');
  });

  it('the fork-shaped declarations already on disk stay valid', async () => {
    // The shapes HominisFable's 44 declarations were rewritten into by hand:
    // a multi-line array element, and a whole two-entry one-liner. A fix that
    // stranded these would make the downstream queue red again.
    const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
    const manifest = JSON.parse(raw) as PatchesManifest;
    for (const patch of manifest.patches) {
      if (patch.filename === '111-ui-beta.patch') {
        patch.stagedDependencies = {
          registrations: [
            {
              file: BETA_MANIFEST,
              line: '"file_beta_one.html",',
              creates: 'browser/beta/test/file_beta_one.html',
              owner: '301-ui-fixtures.patch',
            },
            {
              file: BETA_MANIFEST,
              line: '"file_beta_two.html",',
              creates: 'browser/beta/test/file_beta_two.html',
            },
          ],
        };
      }
      if (patch.filename === '201-ui-gamma.patch') {
        patch.stagedDependencies = {
          registrations: ['a', 'b'].map((suffix) => ({
            file: GAMMA_MANIFEST,
            line: 'support-files = ["file_gamma_a.html", "file_gamma_b.html"]',
            creates: `browser/gamma/test/file_gamma_${suffix}.html`,
          })),
        };
      }
    }
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));

    const after = await lint();
    expect(findings(after, 'staged-dependency-unused')).toEqual([]);
    // Only alpha, still undeclared, is left flagged.
    expect(findings(after, 'forward-registration').map((issue) => issue.patches)).toEqual([
      ['102-ui-alpha.patch'],
    ]);
  });

  it('the unused remedy removes exactly what the discharge command added', async () => {
    const issue = findings(await lint(), 'forward-registration').find((candidate) =>
      candidate.message.includes('file_beta_one.html')
    );
    const added = parseDischargeCommand(issue?.message ?? '');
    await apply(added);
    expect(await loadRegistrations('111-ui-beta.patch')).toHaveLength(1);

    // Drop the fixture creation so the declaration goes stale and the
    // warning — with its own paste-and-run remedy — appears.
    await writeFile(
      join(patchesDir, '301-ui-fixtures.patch'),
      FIXTURES.filter((path) => !path.endsWith('file_beta_one.html'))
        .map((path) => createFileDiff(path, ['<!doctype html>']))
        .join('')
    );

    const unused = findings(await lint(), 'staged-dependency-unused');
    expect(unused).toHaveLength(1);
    const remedy = parseDischargeCommand(unused[0]?.message ?? '');
    expect(remedy.mode).toBe('remove');
    expect(remedy.line).toBe(added.line);
    await apply(remedy);
    expect(await loadRegistrations('111-ui-beta.patch')).toEqual([]);
  });
});
