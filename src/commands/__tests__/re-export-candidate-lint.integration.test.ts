// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchMetadata } from '../../types/commands/index.js';
import { buildReExportLintContext, lintReExportedPatch } from '../re-export-lint.js';

const file = 'browser/modules/fixture/Value.sys.mjs';
const clean =
  '/* SPDX-License-Identifier: EUPL-1.2 */\n/** @type {number} */\nexport const value = 1;\n';
const bad = clean.replace('value = 1', 'value = "wrong"');
const patch: PatchMetadata = {
  filename: '001-ui-value.patch',
  order: 1,
  category: 'ui',
  name: 'value',
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  sourceEsrVersion: '153.6.0esr',
  filesAffected: [file],
};
function body(content: string): string {
  const lines = content.trimEnd().split('\n');
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
}
let root: string;
beforeEach(async () => {
  root = await createTempProject('ff-candidate-integration-');
  await writeFireForgeConfig(root, { patchLint: { checkJs: true } });
  await initCommittedRepo(join(root, 'engine'), { '.keep': '' });
  await writeFiles(root, {
    'patches/patches.json': JSON.stringify({ version: 1, patches: [patch] }),
    [`patches/${patch.filename}`]: body(clean),
    [`engine/${file}`]: clean,
  });
});
afterEach(async () => {
  await removeTempProject(root);
});

describe('hunk-selected re-export quality gates', () => {
  it.each([
    [clean, bad, true],
    [bad, clean, false],
  ] as const)(
    'lints the actual proposed patch rather than the working tree or hoisted program',
    async (working, selected, fails) => {
      await writeFiles(root, { [`engine/${file}`]: working });
      const config = await loadConfig(root);
      const paths = getProjectPaths(root);
      const lintCtx = await buildReExportLintContext(
        root,
        paths,
        config,
        true,
        new Set([patch.filename])
      );
      const run = lintReExportedPatch({
        lintCtx,
        patch,
        projectedMetadata: patch,
        existingFiles: [file],
        diffContent: body(selected),
        syntheticInput: true,
      });
      if (fails) await expect(run).rejects.toThrow(/lint/i);
      else {
        const result = await run;
        expect(result?.issues.filter((issue) => issue.check === 'checkjs-type-error')).toEqual([]);
      }
      expect(await readFile(join(root, 'engine', file), 'utf8')).toBe(working);
    }
  );
});
