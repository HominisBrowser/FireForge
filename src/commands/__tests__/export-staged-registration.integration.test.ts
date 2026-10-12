// SPDX-License-Identifier: EUPL-1.2
/**
 * A new system module whose moz.build line is still unexported drift in
 * the registering patch: refused with the exact steps when undeclared,
 * accepted (with a "re-export the owner next" note) once the registering
 * patch declares the staged registration and the working tree carries it.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import * as logger from '../../utils/logger.js';
import { computeExactPlacementPlan, projectPlacementForLint } from '../export-flow.js';

const MOZBUILD = 'browser/modules/moz.build';
const WORDS = 'browser/modules/Words.sys.mjs';
const CONSUMER = 'browser/modules/Consumer.sys.mjs';

function newFileDiff(path: string, lines: readonly string[]): string {
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

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'infra',
    name: 'x',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

const PENDING = [
  newFileDiff(WORDS, ['export const words = [];']),
  newFileDiff(CONSUMER, [
    'import { words } from "resource:///modules/Words.sys.mjs";',
    'export const count = words.length;',
  ]),
].join('');

describe('export --order with a registration still in the working tree', () => {
  let projectRoot: string;
  let patchesDir: string;
  const registrar = meta('102-infra-modules.patch', 102, [MOZBUILD]);

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-export-reg-');
    patchesDir = join(projectRoot, 'patches');
    await writeFiles(join(projectRoot, 'engine'), {
      [MOZBUILD]: 'EXTRA_JS_MODULES += [\n    "Existing.sys.mjs",\n    "Words.sys.mjs",\n]\n',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  async function seed(metadata: PatchMetadata): Promise<void> {
    await ensureDir(patchesDir);
    await writeFile(
      join(patchesDir, metadata.filename),
      newFileDiff(MOZBUILD, ['EXTRA_JS_MODULES += [', '    "Existing.sys.mjs",', ']'])
    );
    const manifest: PatchesManifest = { version: 1, patches: [metadata] };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
  }

  it('refuses an undeclared one with the exact three-step sequence', async () => {
    await seed(registrar);
    const plan = computeExactPlacementPlan([registrar], 'infra', 'words', 110);

    const conflicts = await projectPlacementForLint(patchesDir, plan, PENDING);

    const text = conflicts?.details.join('\n') ?? '';
    expect(text).toContain('unregistered-system-module');
    expect(text).toContain(
      `${WORDS} is registered in the working tree's ${MOZBUILD}, but 102-infra-modules.patch has not exported that line.`
    );
    expect(text).toContain(
      `  1. fireforge patch staged-dependency 102-infra-modules.patch --add --kind registration --file ${MOZBUILD} ` +
        `--line "\\"Words.sys.mjs\\"," --creates ${WORDS} --owner 110-infra-words.patch --reason '<why`
    );
    expect(text).toContain('  3. fireforge re-export 102-infra-modules.patch');
    expect(text).toContain('Register first');
  });

  it('accepts a declared one and says to re-export the registering patch next', async () => {
    await seed({
      ...registrar,
      stagedDependencies: {
        registrations: [
          {
            file: MOZBUILD,
            line: '"Words.sys.mjs",',
            creates: WORDS,
            owner: '110-infra-words.patch',
          },
        ],
      },
    });
    const warnings: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
      warnings.push(message);
    });
    const plan = computeExactPlacementPlan([registrar], 'infra', 'words', 110);

    expect(await projectPlacementForLint(patchesDir, plan, PENDING)).toBeNull();
    expect(warnings.join('\n')).toContain(
      'Re-export 102-infra-modules.patch right after this export to land the line: ' +
        'fireforge re-export 102-infra-modules.patch'
    );
  });

  it('keeps refusing when the declared line is not in the working tree', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [MOZBUILD]: 'EXTRA_JS_MODULES += [\n    "Existing.sys.mjs",\n]\n',
    });
    await seed({
      ...registrar,
      stagedDependencies: {
        registrations: [{ file: MOZBUILD, line: '"Words.sys.mjs",', creates: WORDS }],
      },
    });
    const plan = computeExactPlacementPlan([registrar], 'infra', 'words', 110);

    const conflicts = await projectPlacementForLint(patchesDir, plan, PENDING);
    expect(conflicts?.details.join('\n')).toContain('unregistered-system-module');
  });
});
