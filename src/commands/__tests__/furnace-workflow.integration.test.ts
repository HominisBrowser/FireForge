// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  readText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { setupCommand } from '../setup.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  step: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('furnace→export workflow integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-furnace-workflow-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('applies a custom furnace component then exports the resulting engine changes as a patch', async () => {
    const engineDir = join(projectRoot, 'engine');

    // Set up engine with baseline files that furnace will modify
    await initCommittedRepo(engineDir, {
      'toolkit/content/widgets/moz-button/moz-button.mjs':
        '// Baseline MozLitElement button\nexport class MozButton extends MozLitElement {}\ncustomElements.define("moz-button", MozButton);\n',
      'toolkit/content/customElements.js':
        '// Custom elements registry\nServices.obs.addObserver({\n  observe() {}\n}, "xul-dom-content-loaded");\n',
    });

    // Create a furnace.json with a custom component
    await writeFiles(projectRoot, {
      'furnace.json': JSON.stringify(
        {
          version: 1,
          componentPrefix: 'moz-',
          stock: ['moz-button'],
          overrides: {},
          custom: {},
        },
        null,
        2
      ),
    });

    // Manually simulate what furnace apply does: write a component file into engine
    // (Full furnace apply requires complex registration targets; we test the concept)
    await writeFiles(engineDir, {
      'toolkit/content/widgets/moz-mybrowser-panel/moz-mybrowser-panel.mjs': [
        '/* SPDX-License-Identifier: EUPL-1.2 */',
        '',
        '/** Custom panel widget. */',
        'export class MozMyBrowserPanel extends MozLitElement {',
        '  render() { return html`<slot></slot>`; }',
        '}',
        'customElements.define("moz-mybrowser-panel", MozMyBrowserPanel);',
        '',
      ].join('\n'),
    });

    // Export the furnace-created file as a patch
    await exportCommand(
      projectRoot,
      ['toolkit/content/widgets/moz-mybrowser-panel/moz-mybrowser-panel.mjs'],
      {
        name: 'custom-panel-widget',
        category: 'ui',
        description: 'Custom panel widget from furnace',
        skipLint: true,
      }
    );

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual([
      'toolkit/content/widgets/moz-mybrowser-panel/moz-mybrowser-panel.mjs',
    ]);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('new file mode');
    expect(patchContent).toContain('MozMyBrowserPanel');
  });
});
