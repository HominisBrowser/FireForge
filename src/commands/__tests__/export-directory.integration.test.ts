// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  runGit,
  writeFiles,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { setupCommand } from '../setup.js';

vi.mock('../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});

let projectRoot: string | undefined;
afterEach(async () => {
  if (projectRoot) await removeTempProject(projectRoot);
});

it('exports tracked and untracked directory files into a patch that git can apply', async () => {
  projectRoot = await createTempProject('fireforge-export-directory-');
  await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  const engineDir = join(projectRoot, 'engine');
  await initCommittedRepo(engineDir, { 'dir/a.js': 'export const a = "original";\n' });
  await writeFiles(engineDir, {
    'dir/a.js': 'export const a = "changed";\n',
    'dir/b.js': 'export const b = "added";\n',
  });

  await exportCommand(projectRoot, ['dir'], {
    name: 'directory',
    category: 'ui',
    description: 'Directory changes',
    skipLint: true,
  });

  const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
  expect(manifest?.patches).toHaveLength(1);
  const patch = manifest?.patches[0];
  if (!patch) throw new Error('Export did not produce a patch');
  expect(patch.filesAffected).toEqual(['dir/a.js', 'dir/b.js']);
  const patchPath = join(projectRoot, 'patches', patch.filename);
  const body = await readProjectText(projectRoot, `patches/${patch.filename}`);
  expect(body).toContain('+export const a = "changed";');
  expect(body).toContain('+export const b = "added";');
  await runGit(engineDir, ['apply', '--cached', '--check', patchPath]);
});
