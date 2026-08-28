// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `fireforge verify`, built on a temp patches
 * directory. Exercises three scenarios:
 *   1. clean queue → exits 0
 *   2. duplicate /dev/null creation → errors
 *   3. forward import from earlier to later patch → errors
 * Plus the end-to-end repair scenario: build a broken queue, run verify
 * (expect failure), use patch delete + re-export --files + patch reorder to
 * fix it, re-run verify (expect clean).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralError } from '../../errors/base.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { lintCommand } from '../lint.js';
import { verifyCommand } from '../verify.js';

async function seedManifestAndPatches(
  patchesDir: string,
  patches: Array<{ metadata: PatchMetadata; body: string }>
): Promise<void> {
  await ensureDir(patchesDir);
  for (const p of patches) {
    await writeFile(join(patchesDir, p.metadata.filename), p.body);
  }
  const manifest: PatchesManifest = {
    version: 1,
    patches: patches.map((p) => p.metadata),
  };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

function createDiff(newFilePath: string, content: string): string {
  const lines = content.split('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${newFilePath} b/${newFilePath}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${newFilePath}`,
    hunk,
  ].join('\n');
}

function createModifyDiff(filePath: string, before: string, after: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'index 1111111..2222222 100644',
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
  ].join('\n');
}

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'infra',
    name: 'test',
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

describe('verify command', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;
  let stdout: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-verify-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    restoreTTY = setInteractiveMode(false);
    // Silence logger output during tests by stubbing methods on the
    // loaded singleton.
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('passes on a clean queue', async () => {
    const diffA = createDiff('foo/A.sys.mjs', 'export const A = 1;');
    const diffB = createDiff('foo/B.sys.mjs', 'export const B = 2;');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: diffB,
      },
    ]);

    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();
  });

  it('warns when engine contains unowned changed files', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/branding/hominis/configure.sh': 'MOZ_APP_DISPLAYNAME="Hominis"\n',
    });
    await writeFile(join(projectRoot, 'engine/browser/branding/hominis/Assets.car'), 'asset\n');
    const diff = createDiff(
      'browser/branding/hominis/configure.sh',
      'MOZ_APP_DISPLAYNAME="Hominis"'
    );
    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-branding.patch', 1, [
          'browser/branding/hominis/configure.sh',
        ]),
        body: diff,
      },
    ]);

    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();

    expect(stdout).toContain('Unowned worktree changes (1)');
    expect(stdout).toContain('browser/branding/hominis/Assets.car');
    expect(stdout).toContain('Verify passed with warnings');
  });

  it('warns when a claimed worktree file has patch-owned drift', async () => {
    const file = 'browser/components/sessionstore/SessionStore.sys.mjs';
    await initCommittedRepo(join(projectRoot, 'engine'), {
      [file]: 'before\n',
    });
    await writeFile(join(projectRoot, 'engine', file), 'manual resolution\n');
    const diff = createModifyDiff(file, 'before', 'expected patch output');
    await seedManifestAndPatches(patchesDir, [
      {
        metadata: {
          ...makeMetadata('010-ui-sessionstore.patch', 10, [file]),
          sourceEsrVersion: '152.0b6',
          sourceProduct: 'firefox-devedition',
          sourceVersion: '152.0b6',
        },
        body: diff,
      },
    ]);

    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();

    expect(stdout).toContain('Patch-owned worktree drift (1)');
    expect(stdout).toContain(file);
    expect(stdout).not.toContain('Unowned worktree changes (1)');
    expect(stdout).toContain('Verify passed with warnings');
  });

  it('fails on duplicate /dev/null creation across two patches', async () => {
    const diffA = createDiff('foo/Dup.sys.mjs', 'export const Dup = 1;');
    const diffA2 = createDiff('foo/Dup.sys.mjs', 'export const Dup = 2;');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/Dup.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/Dup.sys.mjs']),
        body: diffA2,
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });

  it('fails on forward import from earlier to later patch', async () => {
    const diffA = createDiff(
      'foo/A.sys.mjs',
      'import { B } from "resource:///modules/B.sys.mjs";\nexport const A = B;'
    );
    const diffB = createDiff('foo/B.sys.mjs', 'export const B = 1;');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['foo/A.sys.mjs']),
        body: diffA,
      },
      {
        metadata: makeMetadata('002-infra-b.patch', 2, ['foo/B.sys.mjs']),
        body: diffB,
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });

  it('fails when the manifest is missing a patch file on disk', async () => {
    // Seed manifest + one file, then lie to it by referencing a filename
    // that does not exist.
    await ensureDir(patchesDir);
    const manifest: PatchesManifest = {
      version: 1,
      patches: [makeMetadata('001-infra-ghost.patch', 1, ['foo/Ghost.sys.mjs'])],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest));

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });

  it('fails on a structurally valid queue that violates patchPolicy', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [{ from: 200, to: 299, category: 'ui' }],
        reservedRanges: [{ from: 900, to: 999, allowed: [] }],
      },
    });
    const diff = createDiff('foo/Late.sys.mjs', 'export const Late = 1;');
    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('900-ui-late-product.patch', 900, ['foo/Late.sys.mjs']),
        body: diff,
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toBeInstanceOf(GeneralError);
  });

  it('reports patchPolicy violations in lint --per-patch', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [{ from: 200, to: 299, category: 'ui' }],
        reservedRanges: [{ from: 900, to: 999, allowed: [] }],
      },
    });
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'foo/Late.sys.mjs': 'export const Late = 1;\n',
    });
    const diff = createDiff('foo/Late.sys.mjs', 'export const Late = 1;');
    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('900-ui-late-product.patch', 900, ['foo/Late.sys.mjs']),
        body: diff,
      },
    ]);

    await expect(lintCommand(projectRoot, [], { perPatch: true })).rejects.toBeInstanceOf(
      GeneralError
    );
  });

  // `export-all --exclude-furnace` can land a patch that registers a widget
  // via jar.mn / customElements.js edits while excluding the widget source
  // files themselves. Verify reports "Verify clean" for it, because the
  // manifest is internally consistent. The dangling-registration check walks
  // each patch body, extracts component-shaped references, and fails when
  // the referenced path is supplied by no patch AND does not exist in
  // engine/.
  it('fails on a patch that registers a widget it does not itself carry', async () => {
    const registrationBody = [
      'diff --git a/toolkit/content/jar.mn b/toolkit/content/jar.mn',
      'index abc..def 100644',
      '--- a/toolkit/content/jar.mn',
      '+++ b/toolkit/content/jar.mn',
      '@@ -126,6 +126,7 @@ toolkit.jar:',
      '    content/global/elements/moz-label.mjs       (widgets/moz-label/moz-label.mjs)',
      '+   content/global/elements/moz-qa-panel.mjs  (widgets/moz-qa-panel/moz-qa-panel.mjs)',
      '',
    ].join('\n');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-ui-registration.patch', 1, ['toolkit/content/jar.mn']),
        body: registrationBody,
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toThrow(/fireforge verify found/i);
  });

  it('passes when the registration references a file another patch in the queue creates', async () => {
    // Patch 1 creates the widget source; patch 2 registers it via
    // jar.mn. The cross-patch coverage set (union of filesAffected)
    // satisfies the reference, so verify stays quiet.
    const widgetDiff = createDiff(
      'toolkit/content/widgets/moz-qa-panel/moz-qa-panel.mjs',
      'export class MozQaPanel {}'
    );
    const registrationBody = [
      'diff --git a/toolkit/content/jar.mn b/toolkit/content/jar.mn',
      'index abc..def 100644',
      '--- a/toolkit/content/jar.mn',
      '+++ b/toolkit/content/jar.mn',
      '@@ -126,6 +126,7 @@ toolkit.jar:',
      '    content/global/elements/moz-label.mjs       (widgets/moz-label/moz-label.mjs)',
      '+   content/global/elements/moz-qa-panel.mjs  (widgets/moz-qa-panel/moz-qa-panel.mjs)',
      '',
    ].join('\n');

    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-ui-widget.patch', 1, [
          'toolkit/content/widgets/moz-qa-panel/moz-qa-panel.mjs',
        ]),
        body: widgetDiff,
      },
      {
        metadata: makeMetadata('002-ui-registration.patch', 2, ['toolkit/content/jar.mn']),
        body: registrationBody,
      },
    ]);

    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();
  });

  it('fails on a binary body that carries no reconstructable payload', async () => {
    // A "Binary files … differ" body still carries a correct index line, so
    // every hash-keyed check reports the file as backed while the bytes are
    // gone. Verify is the gate that reads the body itself.
    const cert = 'toolkit/certs/release_primary.der';
    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-certs.patch', 1, [cert]),
        body: [
          `diff --git a/${cert} b/${cert}`,
          'index 1d94f88ad7..37ae6960c3 100644',
          `Binary files a/${cert} and b/${cert} differ`,
          '',
        ].join('\n'),
      },
    ]);

    await expect(verifyCommand(projectRoot)).rejects.toThrow(/fireforge verify found/i);
    expect(stdout).toContain('binary-body-not-reconstructable');
    expect(stdout).toContain(cert);
  });

  it('passes on the same patch once the body carries a GIT binary patch delta', async () => {
    const cert = 'toolkit/certs/release_primary.der';
    await seedManifestAndPatches(patchesDir, [
      {
        metadata: makeMetadata('001-infra-certs.patch', 1, [cert]),
        body: [
          `diff --git a/${cert} b/${cert}`,
          'index 1d94f88ad7bb4e5e1b1a0c9a0f0e6d4c3b2a1908..37ae6960c3aa1b2c3d4e5f60718293a4b5c6d7e8 100644',
          'GIT binary patch',
          'literal 8',
          'PcmZQzWX><iNG$>Y29N?L',
          '',
          'literal 9',
          'QcmZQzWJ=1+ODw7c00^)Gi2wiq',
          '',
        ].join('\n'),
      },
    ]);

    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();
  });
});
