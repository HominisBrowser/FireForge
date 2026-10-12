// SPDX-License-Identifier: EUPL-1.2
/**
 * The `--refuse-foreign-drift` belt in both directions and beside scan
 * adoption: a deletion-only edit is drift (expected or refused), the belt
 * guards a patch's existing files while `--scan-file` adopts new ones,
 * `--scan-file <patch>:<path>` spreads one belted call across a creating
 * and a refreshing patch, `--expect-removed` retires a patch-modified
 * upstream file back at HEAD, and the re-export policy gate judges only
 * the patch it writes.
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
import type { PatchPolicyConfig } from '../../types/config.js';
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

interface Row {
  filename: string;
  files: string[];
  category?: string;
}

function manifest(rows: Row[]): string {
  return `${JSON.stringify(
    {
      version: 1,
      patches: rows.map((row) => ({
        filename: row.filename,
        order: Number.parseInt(row.filename.slice(0, 3), 10),
        category: row.category ?? 'ui',
        name: row.filename.replace(/^\d{3}-[a-z]+-/, '').replace(/\.patch$/, ''),
        description: 'test patch',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: row.files,
      })),
    },
    null,
    2
  )}\n`;
}

function filesAffected(manifestText: string, filename: string): string[] | undefined {
  const parsed = JSON.parse(manifestText) as {
    patches: { filename: string; filesAffected: string[] }[];
  };
  return parsed.patches.find((row) => row.filename === filename)?.filesAffected;
}

function infoLines(): string[] {
  return vi.mocked(info).mock.calls.map((call) => call[0]);
}

function warnLines(): string[] {
  return vi.mocked(warn).mock.calls.map((call) => call[0]);
}

const BASE = 'line1\nline2\nline3\n';

let projectRoot: string;
let restoreTTY: (() => void) | undefined;

/** Seeds the engine, writes stub bodies and materializes them with a first re-export. */
async function seed(
  rows: Row[],
  head: Record<string, string>,
  edits: Record<string, string>,
  config: Parameters<typeof writeFireForgeConfig>[1] = {}
): Promise<void> {
  await writeFireForgeConfig(projectRoot, config);
  await initCommittedRepo(join(projectRoot, 'engine'), head);
  const stubs: Record<string, string> = { 'patches/patches.json': manifest(rows) };
  for (const row of rows) {
    stubs[`patches/${row.filename}`] = `diff --git a/${row.files[0]} b/${row.files[0]}\n`;
  }
  await writeFiles(projectRoot, stubs);
  await writeFiles(join(projectRoot, 'engine'), edits);
  await reExportCommand(
    projectRoot,
    rows.map((row) => row.filename),
    {}
  );
  vi.clearAllMocks();
}

beforeEach(async () => {
  vi.clearAllMocks();
  restoreTTY = setInteractiveMode(false);
  projectRoot = await createTempProject();
});

afterEach(async () => {
  restoreTTY?.();
  await removeTempProject(projectRoot);
});

describe('--refuse-foreign-drift counts removed lines', () => {
  const OWNED = 'comp/mod.js';
  const OTHER = 'comp/other.js';
  const PATCHED = 'line1\nline2\npatched line\nsecond patched line\nline3\n';
  const DELETED = 'line1\nline2\npatched line\nline3\n';

  beforeEach(async () => {
    await seed(
      [{ filename: '001-ui-mod.patch', files: [OWNED, OTHER] }],
      { [OWNED]: BASE, [OTHER]: BASE },
      { [OWNED]: PATCHED, [OTHER]: PATCHED }
    );
  });

  it('treats a deletion-only edit in an --expect file as that file’s drift, not a stale --expect', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: DELETED });

    await reExportCommand(projectRoot, ['001'], { refuseForeignDrift: true, expect: [OWNED] });

    expect(infoLines()).toContainEqual(
      expect.stringContaining(`${OWNED}: +0 added / -1 removed line(s) (expected via --expect)`)
    );
    expect(warnLines()).toContainEqual(
      expect.stringContaining('refreshed body changes 1 line against the old patch body')
    );
    expect(warnLines().join('\n')).not.toContain('showed no drift');
    const body = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');
    expect(body.match(/\+second patched line/g)).toHaveLength(1);
  });

  it('refuses a removal in a file outside --expect, leaving the body untouched', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: DELETED, [OTHER]: DELETED });
    const before = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseForeignDrift: true, expect: [OWNED] })
    ).rejects.toThrow(/add or drop lines.*--refuse-foreign-drift/s);

    expect(infoLines()).toContainEqual(
      expect.stringContaining(`${OTHER}: +0 added / -1 removed line(s) [`)
    );
    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).resolves.toBe(before);
  });

  it('refuses an owned file whose engine copy went back to HEAD unless it is expected', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OTHER]: BASE });

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseForeignDrift: true })
    ).rejects.toThrow('--refuse-foreign-drift');
    expect(infoLines()).toContainEqual(
      expect.stringContaining(`${OTHER}: +0 added / -2 removed line(s)`)
    );
  });
});

describe('--refuse-foreign-drift beside --scan-file adoption', () => {
  const OWNED = 'comp/mod.js';
  const ADOPTED = 'comp/new.txt';
  const PATCHED = 'line1\nline2\npatched line\nline3\n';

  beforeEach(async () => {
    await seed(
      [{ filename: '001-ui-mod.patch', files: [OWNED] }],
      { [OWNED]: BASE },
      {
        [OWNED]: PATCHED,
      }
    );
  });

  it('adopts the scanned file and counts it as expected', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [ADOPTED]: 'export const x = 1;\n' });

    await reExportCommand(projectRoot, ['001'], {
      scan: true,
      scanFiles: [ADOPTED],
      refuseForeignDrift: true,
      expect: [ADOPTED],
    });

    const rows = await readProjectText(projectRoot, 'patches/patches.json');
    expect(filesAffected(rows, '001-ui-mod.patch')).toEqual([OWNED, ADOPTED]);
    expect(await readProjectText(projectRoot, 'patches/001-ui-mod.patch')).toContain(
      '+export const x = 1;'
    );
    expect(warnLines().join('\n')).not.toContain('showed no drift');
  });

  it("refuses the adoption when the patch's existing files carry foreign lines", async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [ADOPTED]: 'export const x = 1;\n',
      [OWNED]: 'line1\nforeign line\nline2\npatched line\nline3\n',
    });
    const beforeBody = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');
    const beforeRows = await readProjectText(projectRoot, 'patches/patches.json');

    await expect(
      reExportCommand(projectRoot, ['001'], {
        scan: true,
        scanFiles: [ADOPTED],
        refuseForeignDrift: true,
      })
    ).rejects.toThrow('--refuse-foreign-drift');

    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).resolves.toBe(
      beforeBody
    );
    await expect(readProjectText(projectRoot, 'patches/patches.json')).resolves.toBe(beforeRows);
  });
});

describe('--scan-file <patch>:<path> across several patches', () => {
  const SHELL = 'shell/shell.js';
  const TILES = 'tiles/tiles.js';
  const NEW_TILE = 'tiles/new-tile.txt';
  const SIBLING = 'shell/unrelated.js';

  beforeEach(async () => {
    await seed(
      [
        { filename: '001-ui-shell.patch', files: [SHELL] },
        { filename: '002-ui-tiles.patch', files: [TILES] },
      ],
      { [SHELL]: BASE, [TILES]: BASE },
      { [SHELL]: 'line1\nshell edit\nline2\nline3\n', [TILES]: 'line1\ntiles edit\nline2\nline3\n' }
    );
  });

  it('adopts into the named patch and refreshes the other scan-less, under one belt', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [NEW_TILE]: 'export const tile = 1;\n',
      [SHELL]: 'line1\nshell edit\nshell uses the new tile\nline2\nline3\n',
      // A broad --scan of 001 would sweep this sibling in; the per-file
      // form leaves 001 scan-less.
      [SIBLING]: 'not part of this change\n',
    });

    await reExportCommand(projectRoot, ['001', '002'], {
      scan: true,
      scanFiles: [`002:engine/${NEW_TILE}`],
      refuseForeignDrift: true,
      expect: [SHELL],
    });

    const rows = await readProjectText(projectRoot, 'patches/patches.json');
    expect(filesAffected(rows, '001-ui-shell.patch')).toEqual([SHELL]);
    expect(filesAffected(rows, '002-ui-tiles.patch')).toEqual([NEW_TILE, TILES]);
    expect(await readProjectText(projectRoot, 'patches/001-ui-shell.patch')).toContain(
      '+shell uses the new tile'
    );
  });

  it('refuses an owner that is not among the selected patches', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [NEW_TILE]: 'export const tile = 1;\n' });

    await expect(
      reExportCommand(projectRoot, ['001'], { scan: true, scanFiles: [`002:${NEW_TILE}`] })
    ).rejects.toThrow('002-ui-tiles.patch is not among the selected patches');
  });

  it('refuses an unknown owner and a path given two owners', async () => {
    await expect(
      reExportCommand(projectRoot, ['001', '002'], {
        scan: true,
        scanFiles: [`999:${NEW_TILE}`],
      })
    ).rejects.toThrow('--scan-file');
    await expect(
      reExportCommand(projectRoot, ['001', '002'], {
        scan: true,
        scanFiles: [`001:${NEW_TILE}`, `002:${NEW_TILE}`],
      })
    ).rejects.toThrow('assigned to more than one patch');
  });
});

describe('--expect-removed for a patch-modified upstream file back at HEAD', () => {
  const ART = 'branding/art.txt';
  const PRUNED = 'branding/promo.txt';
  const OTHER = 'branding/other.txt';
  const policy: PatchPolicyConfig = {
    ranges: [
      { category: 'ui', from: 1, to: 899 },
      { category: 'branding', from: 900, to: 999 },
    ],
    reservedRanges: [
      {
        from: 900,
        to: 999,
        allowed: [
          {
            filename: '905-branding-art.patch',
            documentation: 'docs/art.md',
            files: [ART, PRUNED],
          },
          { filename: '906-branding-other.patch', documentation: 'docs/other.md' },
        ],
      },
    ],
  };
  const rows: Row[] = [
    { filename: '905-branding-art.patch', files: [ART, PRUNED], category: 'branding' },
    { filename: '906-branding-other.patch', files: [OTHER], category: 'branding' },
  ];

  beforeEach(async () => {
    await seed(
      rows,
      { [ART]: BASE, [PRUNED]: BASE, [OTHER]: BASE },
      {
        [ART]: 'line1\nart edit\nline2\nline3\n',
        [PRUNED]: 'line1\npromo edit\nline2\nline3\n',
        [OTHER]: 'line1\nother edit\nline2\nline3\n',
      },
      { patchPolicy: policy }
    );
    // Prune the path from the allowlist and restore its engine copy.
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ...policy,
        reservedRanges: [
          {
            from: 900,
            to: 999,
            allowed: [
              { filename: '905-branding-art.patch', documentation: 'docs/art.md', files: [ART] },
              { filename: '906-branding-other.patch', documentation: 'docs/other.md' },
            ],
          },
        ],
      },
    });
    await writeFiles(join(projectRoot, 'engine'), { [PRUNED]: BASE });
  });

  it('drops the path from body and filesAffected in a belted scan-less call', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [OTHER]: 'line1\nother edit 2\nline2\nline3\n',
    });

    await reExportCommand(projectRoot, ['905', '906'], {
      refuseForeignDrift: true,
      expect: [OTHER],
      expectRemoved: [PRUNED],
    });

    const manifestText = await readProjectText(projectRoot, 'patches/patches.json');
    expect(filesAffected(manifestText, '905-branding-art.patch')).toEqual([ART]);
    expect(await readProjectText(projectRoot, 'patches/905-branding-art.patch')).not.toContain(
      PRUNED
    );
    expect(await readProjectText(projectRoot, 'patches/906-branding-other.patch')).toContain(
      '+other edit 2'
    );
  });

  it('without the retirement refuses only the stale patch and names the remedy', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [OTHER]: 'line1\nother edit 2\nline2\nline3\n',
    });

    await expect(reExportCommand(projectRoot, ['905', '906'], {})).rejects.toThrow(
      /Re-exported only 1 of 2.*Failed: 905-branding-art\.patch/s
    );
    expect(warnLines()).toContainEqual(expect.stringContaining('[reserved-files]'));
    expect(warnLines()).toContainEqual(expect.stringContaining('--expect-removed <path>'));
    expect(await readProjectText(projectRoot, 'patches/906-branding-other.patch')).toContain(
      '+other edit 2'
    );
  });

  it('refuses a tracked path whose engine copy still differs from HEAD', async () => {
    await expect(reExportCommand(projectRoot, ['905'], { expectRemoved: [ART] })).rejects.toThrow(
      'still differs from HEAD'
    );
  });

  it('refuses a tracked path the owner body never changes', async () => {
    await writeFiles(projectRoot, {
      'patches/905-branding-art.patch': `diff --git a/${ART} b/${ART}\n`,
    });
    await expect(
      reExportCommand(projectRoot, ['905'], { expectRemoved: [PRUNED] })
    ).rejects.toThrow('is not changed by its selected patch 905-branding-art.patch');
  });
});

describe('forward jar.mn registrations in the re-export refusals', () => {
  const JAR = 'toolkit/content/jar.mn';
  const JAR_HEAD = 'toolkit.jar:\n  content/global/a.txt  (a.txt)\n';
  const EXISTING_WIDGET = 'toolkit/content/widgets/existing.txt';
  const NEW_WIDGET = 'toolkit/content/widgets/new.txt';
  const REGISTRATION = '  content/global/elements/new.txt  (widgets/new.txt)\n';

  async function seedQueue(jarEdit: string, created: Record<string, string>): Promise<void> {
    await seed(
      [
        { filename: '001-ui-shell.patch', files: [JAR] },
        { filename: '002-ui-widgets.patch', files: Object.keys(created) },
      ],
      { [JAR]: JAR_HEAD },
      { [JAR]: jarEdit, ...created },
      { patchLint: { forwardRegistration: 'extended' } }
    );
  }

  it('refuses a scan-less refresh that adds a forward packaging line, with the declare command', async () => {
    await seedQueue(`${JAR_HEAD}  content/global/b.txt  (b.txt)\n`, {
      [NEW_WIDGET]: 'widget\n',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      [JAR]: `${JAR_HEAD}  content/global/b.txt  (b.txt)\n${REGISTRATION}`,
    });

    await expect(reExportCommand(projectRoot, ['001'], {})).rejects.toThrow(
      'All selected patches failed'
    );
    const warned = warnLines().join('\n');
    expect(warned).toContain('for packaging');
    expect(warned).toContain('fireforge patch staged-dependency 001-ui-shell.patch');
  });

  it('names the registration in the scan adoption refusal of the file it packages', async () => {
    await seedQueue(`${JAR_HEAD}${REGISTRATION}`, { [EXISTING_WIDGET]: 'existing\n' });
    await writeFiles(join(projectRoot, 'engine'), { [NEW_WIDGET]: 'widget\n' });
    const before = await readProjectText(projectRoot, 'patches/patches.json');

    await expect(
      reExportCommand(projectRoot, ['002'], { scan: true, scanFiles: [`002:${NEW_WIDGET}`] })
    ).rejects.toThrow('All selected patches failed');
    const warned = warnLines().join('\n');
    expect(warned).toContain('forward registration the adoption would leave dangling');
    expect(warned).toContain('for packaging');
    await expect(readProjectText(projectRoot, 'patches/patches.json')).resolves.toBe(before);
  });
});
