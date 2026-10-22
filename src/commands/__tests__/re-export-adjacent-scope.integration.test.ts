// SPDX-License-Identifier: EUPL-1.2
/**
 * What `--refuse-adjacent-unmanaged` counts as adjacent, against a real
 * engine repository.
 *
 * The belt must not refuse header-only re-exports over a peer session's
 * unexported test in a sibling directory (`test/hominis-tiles/` beside an
 * owned `test/hominis/`) or two directories down (`hominis/test/unit/` below
 * an owned `hominis/`), since neither file would ever be captured. Adjacent
 * means what the re-export would plausibly have to capture: the same
 * directory as an owned file, or a file a registration line the patch adds
 * names. The carve-outs (`--expect-new` for a file the next export adopts,
 * `--adjacent-ignore` for a reviewed ignore list) admit their files while
 * every other adjacent file still refuses.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { info, warn } from '../../utils/logger.js';
import { reExportCommand } from '../re-export.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

const TEST_DIR = 'browser/base/content/test/hominis';
const TEST_OWNED = `${TEST_DIR}/browser_a.js`;
const MODULE_DIR = 'browser/modules/hominis';
const MODULE_OWNED = `${MODULE_DIR}/HominisA.sys.mjs`;
const COMPONENTS_MOZBUILD = 'browser/components/moz.build';
const NEW_MODULE = 'browser/components/hominis/HominisNew.sys.mjs';
const TOOLKIT_JAR = 'toolkit/content/jar.mn';

function patchEntry(
  order: number,
  name: string,
  files: string[]
): { filename: string } & Record<string, unknown> {
  return {
    filename: `00${order}-ui-${name}.patch`,
    order,
    category: 'ui',
    name,
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: files,
  };
}

const PATCHES = [
  patchEntry(1, 'tests', [TEST_OWNED]),
  patchEntry(2, 'module', [MODULE_OWNED]),
  patchEntry(3, 'registry', [COMPONENTS_MOZBUILD]),
  patchEntry(4, 'widgets', [TOOLKIT_JAR]),
];

function messages(fn: typeof info | typeof warn): string {
  return vi
    .mocked(fn)
    .mock.calls.map((call) => call[0])
    .join('\n');
}

describe('re-export adjacency scope', () => {
  let projectRoot: string;
  let engine: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-adjacent-scope-');
    engine = join(projectRoot, 'engine');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(engine, {
      [TEST_OWNED]: 'a\n',
      [MODULE_OWNED]: 'a\n',
      [COMPONENTS_MOZBUILD]: 'DIRS += [\n    "about",\n]\n',
      [TOOLKIT_JAR]: 'toolkit.jar:\n  content/global/a.js (a.js)\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': `${JSON.stringify({ version: 1, patches: PATCHES }, null, 2)}\n`,
      ...Object.fromEntries(
        PATCHES.map((patch) => [`patches/${patch.filename}`, `diff --git a/x b/x\n`])
      ),
    });
    // Every owned file carries a change, so each patch has a body to write.
    await writeFiles(engine, {
      [TEST_OWNED]: 'a\nb\n',
      [MODULE_OWNED]: 'a\nb\n',
      [COMPONENTS_MOZBUILD]:
        'DIRS += [\n    "about",\n]\nEXTRA_JS_MODULES += [\n    "hominis/HominisNew.sys.mjs",\n]\n',
      [TOOLKIT_JAR]:
        'toolkit.jar:\n  content/global/a.js (a.js)\n  content/global/widgets/*.mjs (widgets/*.mjs)\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('does not count a peer file in a sibling directory as adjacent', async () => {
    await writeFiles(engine, {
      'browser/base/content/test/hominis-tiles/browser_peer.js': 'peer\n',
    });

    await reExportCommand(projectRoot, ['001'], { refuseAdjacentUnmanaged: true, skipLint: true });

    expect(messages(warn)).not.toContain('browser_peer.js');
  });

  it('does not count a peer file two directories below an owned one as adjacent', async () => {
    await writeFiles(engine, { [`${MODULE_DIR}/test/unit/test_peer.js`]: 'peer\n' });

    await reExportCommand(projectRoot, ['002'], { refuseAdjacentUnmanaged: true, skipLint: true });

    expect(messages(warn)).not.toContain('test_peer.js');
  });

  it('still refuses a new file in the same directory, naming it and its anchor', async () => {
    await writeFiles(engine, { [`${TEST_DIR}/browser_new.js`]: 'new\n' });
    const before = await readProjectText(projectRoot, 'patches/001-ui-tests.patch');

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseAdjacentUnmanaged: true, skipLint: true })
    ).rejects.toThrow(
      `001-ui-tests.patch (${TEST_DIR}/browser_new.js (beside engine/${TEST_DIR}))`
    );
    await expect(readProjectText(projectRoot, 'patches/001-ui-tests.patch')).resolves.toBe(before);
  });

  it('refuses an unmanaged file a registration line the patch adds names, in another directory', async () => {
    await writeFiles(engine, { [NEW_MODULE]: 'export {};\n' });

    await expect(
      reExportCommand(projectRoot, ['003'], { refuseAdjacentUnmanaged: true, skipLint: true })
    ).rejects.toThrow(`${NEW_MODULE} (registered by engine/${COMPONENTS_MOZBUILD})`);
  });

  it('refuses a file a wildcard jar.mn line the patch adds matches', async () => {
    await writeFiles(engine, { 'toolkit/content/widgets/new-widget.mjs': 'export {};\n' });

    await expect(
      reExportCommand(projectRoot, ['004'], { refuseAdjacentUnmanaged: true, skipLint: true })
    ).rejects.toThrow(
      `toolkit/content/widgets/new-widget.mjs (registered by engine/${TOOLKIT_JAR})`
    );
  });

  it('--expect-new admits the file the next export adopts and reminds of that export', async () => {
    await writeFiles(engine, { [NEW_MODULE]: 'export {};\n' });

    await reExportCommand(projectRoot, ['003'], {
      refuseAdjacentUnmanaged: true,
      expectNew: [NEW_MODULE],
      skipLint: true,
    });

    expect(messages(info)).toContain('1 adjacent unmanaged file(s) expected by --expect-new');
    expect(messages(info)).toContain(
      `--expect-new admitted ${NEW_MODULE}, which no patch owns yet`
    );
  });

  it("--expect-new still refuses a peer's unmanaged neighbour", async () => {
    await writeFiles(engine, {
      [`${TEST_DIR}/browser_mine.js`]: 'mine\n',
      [`${TEST_DIR}/browser_peer.js`]: 'peer\n',
    });

    await expect(
      reExportCommand(projectRoot, ['001'], {
        refuseAdjacentUnmanaged: true,
        expectNew: [`${TEST_DIR}/browser_mine.js`],
        skipLint: true,
      })
    ).rejects.toThrow(
      `001-ui-tests.patch (${TEST_DIR}/browser_peer.js (beside engine/${TEST_DIR}))`
    );
  });

  it('warns about an --expect-new path no selected patch met', async () => {
    await reExportCommand(projectRoot, ['001'], {
      refuseAdjacentUnmanaged: true,
      expectNew: ['browser/base/content/typo.js'],
      skipLint: true,
    });

    expect(messages(warn)).toContain(
      '--expect-new path(s) were not met as adjacent unmanaged files this run: browser/base/content/typo.js'
    );
  });

  it('--adjacent-ignore admits reviewed files by glob, reports them, and notes unmatched entries', async () => {
    await writeFiles(engine, {
      [`${TEST_DIR}/lab-1.json`]: '{}\n',
      [`${TEST_DIR}/lab-2.json`]: '{}\n',
    });

    await reExportCommand(projectRoot, ['001'], {
      refuseAdjacentUnmanaged: true,
      adjacentIgnore: [`${TEST_DIR}/lab-*.json`, 'widget/headless/unused.txt'],
      skipLint: true,
    });

    expect(messages(info)).toContain('2 adjacent unmanaged file(s) ignored by --adjacent-ignore');
    expect(messages(info)).toContain(
      '--adjacent-ignore entries matched no adjacent file this run: widget/headless/unused.txt.'
    );
  });

  it('a * in an ignore entry does not cross a directory boundary', async () => {
    await writeFiles(engine, { [`${TEST_DIR}/lab-1.json`]: '{}\n' });

    await expect(
      reExportCommand(projectRoot, ['001'], {
        refuseAdjacentUnmanaged: true,
        adjacentIgnore: ['browser/base/content/test/*.json'],
        skipLint: true,
      })
    ).rejects.toThrow('lab-1.json');
  });

  it('ends a multi-patch run with one line naming the written and the unwritten patches', async () => {
    await writeFiles(engine, { [`${TEST_DIR}/browser_new.js`]: 'new\n' });

    await expect(
      reExportCommand(projectRoot, ['001', '002'], {
        refuseAdjacentUnmanaged: true,
        skipLint: true,
        dryRun: true,
      })
    ).rejects.toThrow('Refused 1 patch(es)');

    expect(info).toHaveBeenCalledWith(
      'Re-export summary: would write 1 of 2: 002-ui-module.patch; would NOT write: ' +
        '001-ui-tests.patch (refused: adjacent unmanaged).'
    );
  });
});
