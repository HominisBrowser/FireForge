// SPDX-License-Identifier: EUPL-1.2
/**
 * Adopting a NEW BINARY file through `--scan --scan-file`, against a real
 * git repository.
 *
 * This is the reported 0.44.4 blocker: vendoring eight WOFF2 faces into a
 * patch failed after a clean lint pass with "Cannot extract text content from
 * binary patch section for …". The scan's forward-import projection fed every
 * detected new file to the TEXT extractor, which refuses binary sections by
 * design — so a file whose `GIT binary patch` the export half had just
 * written correctly could not be adopted at all, and the faces stayed
 * unmanaged.
 *
 * The fix skips binary sections in the projection (a binary blob authors no
 * imports, so it contributes nothing to the rule the projection feeds). This
 * test fails on 0.44.4.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, runGit } from '../../test-utils/index.js';
import { assertScanAdoptionsHaveNoForwardImports } from '../re-export-scan.js';

/** NUL bytes are what make git treat this as binary. */
const WOFF2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x00, 0x01, 0x02, 0xff, 0xfe]);

const FONT_DIR = 'browser/themes/shared/hominis/fonts';

describe('scan adoption of new binary files (real git)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await removeTempProject(root);
      root = undefined;
    }
  });

  async function setup(): Promise<{ engine: string; patches: string }> {
    root = await createTempProject('ff-scan-binary-');
    const engine = join(root, 'engine');
    const patches = join(root, 'patches');
    await mkdir(join(engine, FONT_DIR), { recursive: true });
    await mkdir(patches, { recursive: true });

    await runGit(engine, ['init']);
    await runGit(engine, ['config', 'user.email', 'fireforge@example.test']);
    await runGit(engine, ['config', 'user.name', 'FireForge Tests']);
    await writeFile(join(engine, 'seed.txt'), 'seed\n');
    await runGit(engine, ['add', '-A']);
    await runGit(engine, ['commit', '-m', 'initial']);

    return { engine, patches };
  }

  it('adopts eight new WOFF2 faces without refusing', async () => {
    const { engine, patches } = await setup();
    const faces = ['regular', 'italic', 'medium', 'semibold', 'bold', 'light', 'thin', 'black'].map(
      (face) => `${FONT_DIR}/nebula-sans-${face}.woff2`
    );
    for (const face of faces) {
      await writeFile(join(engine, face), WOFF2);
    }

    await expect(
      assertScanAdoptionsHaveNoForwardImports({
        patchesDir: patches,
        engineDir: engine,
        patchFilename: '101-fonts.patch',
        added: faces,
      })
    ).resolves.toBeUndefined();
  });

  it('adopts a mixed text + binary scan, and still sees the text file', async () => {
    const { engine, patches } = await setup();
    const font = `${FONT_DIR}/nebula-sans-regular.woff2`;
    const css = `${FONT_DIR}/fonts.css`;
    await writeFile(join(engine, font), WOFF2);
    await writeFile(join(engine, css), '@font-face { font-family: "Nebula Sans"; }\n');

    // The binary must not poison the projection for its text neighbour: both
    // are adopted in one call, which is how the real vendoring landed.
    await expect(
      assertScanAdoptionsHaveNoForwardImports({
        patchesDir: patches,
        engineDir: engine,
        patchFilename: '101-fonts.patch',
        added: [font, css],
      })
    ).resolves.toBeUndefined();
  });
});
