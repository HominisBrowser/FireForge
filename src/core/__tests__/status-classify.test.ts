// SPDX-License-Identifier: EUPL-1.2
/**
 * Batched status classification: `classifyFiles` builds one
 * patched-content context and classifies under a bounded pool. These
 * real-git cases pin that batching + concurrency changed no semantics:
 * every bucket still lands where the serial per-file classifier put it,
 * order is preserved, and one broken file never fails its siblings.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, initCommittedRepo, writeFiles } from '../../test-utils/index.js';
import { classifyFiles } from '../status-classify.js';

const APP = 'browser/app.txt';
const NEW_FILE = 'browser/created.txt';
const BROKEN = 'browser/broken.txt';

function modifyPatch(file: string, oldLine: string, newLine: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${oldLine}`,
    `+${newLine}`,
    '',
  ].join('\n');
}

function newFilePatch(file: string, line: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${line}`,
    '',
  ].join('\n');
}

interface ManifestRow {
  filename: string;
  filesAffected: string[];
}

function manifestJson(rows: ManifestRow[]): string {
  return `${JSON.stringify(
    {
      version: 1,
      patches: rows.map((row, index) => ({
        filename: row.filename,
        order: index + 1,
        category: 'ui',
        name: row.filename.replace(/^\d+-ui-/, '').replace(/\.patch$/, ''),
        description: 'fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: row.filesAffected,
      })),
    },
    null,
    2
  )}\n`;
}

describe('classifyFiles (batched + concurrent)', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-status-classify-');
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, {
      [APP]: 'line1\n',
      [BROKEN]: 'unrelated content\n',
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('classifies every bucket exactly as the serial classifier did', async () => {
    await writeFiles(projectRoot, {
      'patches/001-ui-app.patch': modifyPatch(APP, 'line1', 'line2'),
      'patches/002-ui-new.patch': newFilePatch(NEW_FILE, 'hello'),
      // Context mismatch against BROKEN's committed content — the per-file
      // comparison throws and must settle as patch-owned-drift.
      'patches/003-ui-broken.patch': modifyPatch(BROKEN, 'never-there', 'still-not'),
      'patches/patches.json': manifestJson([
        { filename: '001-ui-app.patch', filesAffected: [APP] },
        { filename: '002-ui-new.patch', filesAffected: [NEW_FILE] },
        { filename: '003-ui-broken.patch', filesAffected: [BROKEN] },
        { filename: '004-ui-clash.patch', filesAffected: ['browser/shared.txt'] },
        { filename: '005-ui-clash-two.patch', filesAffected: ['browser/shared.txt'] },
        {
          filename: '006-ui-furnace-clash.patch',
          filesAffected: ['browser/components/widgets/Widget.sys.mjs'],
        },
        {
          filename: '007-ui-furnace-clash-two.patch',
          filesAffected: ['browser/components/widgets/Widget.sys.mjs'],
        },
        {
          filename: '008-ui-branding-clash.patch',
          filesAffected: ['browser/branding/testbrand/configure.sh'],
        },
        {
          filename: '009-ui-branding-clash-two.patch',
          filesAffected: ['browser/branding/testbrand/configure.sh'],
        },
      ]),
    });
    await writeFiles(engineDir, {
      [APP]: 'line2\n',
      [NEW_FILE]: 'hello\n',
      [BROKEN]: 'locally edited\n',
      'browser/shared.txt': 'contested\n',
      'browser/loose.txt': 'nobody claims this\n',
      'browser/components/widgets/Widget.sys.mjs': 'furnace deployed\n',
      'browser/branding/testbrand/configure.sh': 'generated\n',
      'browser/branding/testbrand/Assets.car': 'new unowned asset\n',
    });

    const results = await classifyFiles(
      [
        { status: ' M', file: APP },
        { status: '??', file: NEW_FILE },
        { status: ' M', file: BROKEN },
        { status: ' M', file: 'browser/shared.txt' },
        { status: '??', file: 'browser/loose.txt' },
        { status: '??', file: 'browser/components/widgets/Widget.sys.mjs' },
        { status: '??', file: 'browser/branding/testbrand/configure.sh' },
        { status: '??', file: 'browser/branding/testbrand/Assets.car' },
      ],
      engineDir,
      patchesDir,
      'testbrand',
      new Set(['browser/components/widgets/'])
    );

    expect(results.map((r) => [r.file, r.classification])).toEqual([
      [APP, 'patch-backed'],
      [NEW_FILE, 'patch-backed'],
      [BROKEN, 'patch-owned-drift'],
      ['browser/shared.txt', 'conflict'],
      ['browser/loose.txt', 'unmanaged'],
      ['browser/components/widgets/Widget.sys.mjs', 'conflict'],
      // Tool-managed path classification must not hide structural ownership
      // conflicts from status --check/--json.
      ['browser/branding/testbrand/configure.sh', 'conflict'],
      // ...but a brand-new unowned branding asset stays visible (Assets.car).
      ['browser/branding/testbrand/Assets.car', 'unmanaged'],
    ]);
    expect(results[0]?.owner).toBe('001-ui-app.patch');
    expect(results[2]?.owner).toBe('003-ui-broken.patch');
    expect(results[3]?.claimedBy).toEqual(['004-ui-clash.patch', '005-ui-clash-two.patch']);
    expect(results[5]?.claimedBy).toEqual([
      '006-ui-furnace-clash.patch',
      '007-ui-furnace-clash-two.patch',
    ]);
    expect(results[6]?.claimedBy).toEqual([
      '008-ui-branding-clash.patch',
      '009-ui-branding-clash-two.patch',
    ]);
  });

  it('reports drift when live content diverges from the patched expectation', async () => {
    await writeFiles(projectRoot, {
      'patches/001-ui-app.patch': modifyPatch(APP, 'line1', 'line2'),
      'patches/patches.json': manifestJson([
        { filename: '001-ui-app.patch', filesAffected: [APP] },
      ]),
    });
    await writeFiles(engineDir, { [APP]: 'line3-unexpected\n' });

    const results = await classifyFiles(
      [{ status: ' M', file: APP }],
      engineDir,
      patchesDir,
      'testbrand',
      new Set()
    );
    expect(results).toEqual([
      { status: ' M', file: APP, classification: 'patch-owned-drift', owner: '001-ui-app.patch' },
    ]);
  });

  it('reports an unexpected deletion of a patch-owned file as drift', async () => {
    await writeFiles(projectRoot, {
      'patches/001-ui-app.patch': modifyPatch(APP, 'line1', 'line2'),
      'patches/patches.json': manifestJson([
        { filename: '001-ui-app.patch', filesAffected: [APP] },
      ]),
    });
    await rm(join(engineDir, APP));

    const results = await classifyFiles(
      [{ status: ' D', file: APP }],
      engineDir,
      patchesDir,
      'testbrand',
      new Set()
    );
    expect(results[0]?.classification).toBe('patch-owned-drift');
  });

  it('preserves input order across a batch wider than the pool', async () => {
    const files = Array.from(
      { length: 20 },
      (_, i) => `browser/loose-${String(i).padStart(2, '0')}.txt`
    );
    await writeFiles(engineDir, Object.fromEntries(files.map((file) => [file, 'unmanaged\n'])));

    const results = await classifyFiles(
      files.map((file) => ({ status: '??', file })),
      engineDir,
      patchesDir,
      'testbrand',
      new Set()
    );
    expect(results.map((r) => r.file)).toEqual(files);
    expect(results.every((r) => r.classification === 'unmanaged')).toBe(true);
  });
});
