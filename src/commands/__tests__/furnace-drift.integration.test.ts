// SPDX-License-Identifier: EUPL-1.2
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { exportCommand } from '../export.js';
import { furnaceApplyCommand } from '../furnace/apply.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';
import { statusCommand } from '../status.js';

const logger = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  verbose: vi.fn(),
  step: vi.fn(),
  isCancel: vi.fn(() => false),
  isMachineOutputMode: vi.fn(() => false),
  setMachineOutputMode: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

const ORIGINAL_BUTTON_CSS = `:host {
  /* Pristine Firefox baseline */
  background: white;
}
`;

const OVERRIDE_BUTTON_CSS = `:host {
  /* My Browser override */
  background: black;
}
`;

const FURNACE_CONFIG = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {
    'moz-button': {
      type: 'css-only',
      description: 'Recolour moz-button',
      basePath: 'toolkit/content/widgets/moz-button',
      baseVersion: '140.9.0esr',
    },
  },
  custom: {},
} as const;

describe('Furnace drift detection (integration)', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;
  let engineButtonCss: string;
  let workspaceButtonCss: string;
  let stateFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-drift-test-');

    await writeFireForgeConfig(projectRoot);
    await writeFiles(projectRoot, {
      'furnace.json': `${JSON.stringify(FURNACE_CONFIG, null, 2)}\n`,
      'components/overrides/moz-button/moz-button.css': OVERRIDE_BUTTON_CSS,
      'components/overrides/moz-button/override.json': `${JSON.stringify(
        {
          type: 'css-only',
          description: 'Recolour moz-button',
          basePath: 'toolkit/content/widgets/moz-button',
          baseVersion: '140.9.0esr',
        },
        null,
        2
      )}\n`,
    });

    // initCommittedRepo writes files relative to the repo root, so write the
    // baseline css under the engine path inside the repo. Apply needs the
    // engine to be a real git repo for the override workflow to be sound.
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'toolkit/content/widgets/moz-button/moz-button.css': ORIGINAL_BUTTON_CSS,
      'README.txt': 'engine baseline\n',
    });

    engineButtonCss = join(
      projectRoot,
      'engine',
      'toolkit/content/widgets/moz-button/moz-button.css'
    );
    workspaceButtonCss = join(projectRoot, 'components/overrides/moz-button/moz-button.css');
    stateFile = join(projectRoot, '.fireforge', 'furnace-state.json');
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('re-applies an override component when the engine copy has been overwritten', async () => {
    // First apply: copies the override css over the engine baseline.
    await furnaceApplyCommand(projectRoot);

    let engineContent = await readFile(engineButtonCss, 'utf8');
    expect(engineContent).toBe(OVERRIDE_BUTTON_CSS);

    // State file should record the apply.
    const stateContent = await readFile(stateFile, 'utf8');
    expect(stateContent).toContain('override/moz-button/moz-button.css');

    // Simulate drift: a manual edit (or a botched download/reset) overwrote
    // the engine css with a third-party value. The workspace is unchanged,
    // so a checksum-only fast path would skip apply and report "up to date".
    const driftedContent = ':host { background: red !important; }\n';
    await writeFile(engineButtonCss, driftedContent);

    // Re-apply with no workspace changes. The drift detector should notice
    // that the engine content no longer matches the workspace content and
    // re-copy the override.
    await furnaceApplyCommand(projectRoot);

    engineContent = await readFile(engineButtonCss, 'utf8');
    expect(engineContent).toBe(OVERRIDE_BUTTON_CSS);
  });

  it('re-applies the override when the engine copy is missing entirely', async () => {
    await furnaceApplyCommand(projectRoot);
    expect(await readFile(engineButtonCss, 'utf8')).toBe(OVERRIDE_BUTTON_CSS);

    // Simulate the apply target being wiped (e.g. by `fireforge reset --force`).
    const { rm } = await import('node:fs/promises');
    await rm(engineButtonCss);

    await furnaceApplyCommand(projectRoot);

    expect(await readFile(engineButtonCss, 'utf8')).toBe(OVERRIDE_BUTTON_CSS);
  });

  it('skips re-apply when the engine copy still matches the workspace', async () => {
    await furnaceApplyCommand(projectRoot);

    const stateBefore = await readFile(stateFile, 'utf8');
    const engineBefore = await readFile(engineButtonCss, 'utf8');

    // Re-apply with no changes anywhere — drift detector should report no
    // drift and the apply should be a fast-path skip. The workspace file
    // is left untouched.
    expect(await readFile(workspaceButtonCss, 'utf8')).toBe(OVERRIDE_BUTTON_CSS);
    await furnaceApplyCommand(projectRoot);

    expect(await readFile(engineButtonCss, 'utf8')).toBe(engineBefore);
    // The state file's appliedChecksums section should be unchanged.
    const stateAfter = await readFile(stateFile, 'utf8');
    const checksumLineBefore = stateBefore.match(
      /"override:moz-button:moz-button\.css":\s*"[^"]+"/
    );
    const checksumLineAfter = stateAfter.match(/"override:moz-button:moz-button\.css":\s*"[^"]+"/);
    expect(checksumLineAfter?.[0]).toBe(checksumLineBefore?.[0]);
  });

  it('reports patch-owned drift after deploying an edited component over its exported patch', async () => {
    // Ground truth for 0.38.0 friction item 1: deploy the override, export
    // a patch capturing the deployed copy, then edit the workspace source
    // and deploy again. The engine copy now has content the owning patch's
    // body lacks; pre-fix the furnace prefix short-circuit in the status
    // classifier silently bucketed the path as `furnace` and the ownership
    // table row read `owned`.
    await furnaceDeployCommand(projectRoot, undefined, { skipValidate: true });
    expect(await readFile(engineButtonCss, 'utf8')).toBe(OVERRIDE_BUTTON_CSS);

    await exportCommand(projectRoot, ['toolkit/content/widgets/moz-button/moz-button.css'], {
      name: 'moz-button-recolor',
      category: 'ui',
      description: 'Recolour moz-button',
      skipLint: true,
    });

    const editedCss = `:host {
  /* My Browser override, second pass */
  background: rebeccapurple;
}
`;
    await writeFile(workspaceButtonCss, editedCss);
    await furnaceDeployCommand(projectRoot, undefined, { skipValidate: true });
    expect(await readFile(engineButtonCss, 'utf8')).toBe(editedCss);

    // Only the ownership table's rows matter below — drop the deploy and
    // export chatter captured so far.
    logger.info.mockClear();
    await statusCommand(projectRoot, { ownership: true });

    const rows = logger.info.mock.calls.map((call) => String(call[0]));
    const buttonRow = rows.find((row) =>
      row.includes('toolkit/content/widgets/moz-button/moz-button.css')
    );
    expect(buttonRow).toBeDefined();
    expect(buttonRow).toContain('patch-owned drift');
  });
});
