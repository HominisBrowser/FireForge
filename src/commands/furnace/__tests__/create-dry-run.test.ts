// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from '../../../core/config.js';
import { pathExists, writeText } from '../../../utils/fs.js';
import { furnaceCreateCommand } from '../create.js';

describe('furnaceCreateCommand --dry-run', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-create-dry-'));
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      binaryName: 'mybrowser',
      name: 'MyBrowser',
      vendor: 'Vendor',
      appId: 'com.vendor.mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      license: 'MPL-2.0',
    } as never);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not create any component files and does not write furnace.json', async () => {
    // No furnace.json exists. A real create would persist one on disk. Dry-run
    // must exit before any mutation so the authoring workspace is untouched.
    await furnaceCreateCommand(projectRoot, 'moz-preview-widget', {
      description: 'Preview only',
      dryRun: true,
    });

    // No furnace.json was written: dry-run must not persist the auto-created
    // default config, which would otherwise strand config on disk for a
    // command the operator intended as a preview.
    expect(await pathExists(join(projectRoot, 'furnace.json'))).toBe(false);
    // No component directory was created.
    expect(await pathExists(join(projectRoot, 'components/custom/moz-preview-widget'))).toBe(false);
  });

  it('rejects an invalid tag name in dry-run before emitting a plan', async () => {
    // Validation runs in the same order for real and dry runs so operators
    // do not get a misleading "plan emitted" output for a name that would
    // have failed on the real command.
    await expect(furnaceCreateCommand(projectRoot, 'BadName', { dryRun: true })).rejects.toThrow(
      /hyphen|lowercase|pattern/i
    );
  });

  it('rejects a duplicate custom name in dry-run', async () => {
    // Write a furnace.json that already registers the target tag so the
    // conflict check fires before any plan is computed.
    await mkdir(projectRoot, { recursive: true });
    await writeText(
      join(projectRoot, 'furnace.json'),
      JSON.stringify(
        {
          version: 1,
          componentPrefix: 'moz-',
          stock: [],
          overrides: {},
          custom: {
            'moz-preview-widget': {
              description: 'already here',
              targetPath: 'toolkit/content/widgets/moz-preview-widget',
              register: true,
              localized: false,
            },
          },
        },
        null,
        2
      )
    );

    await expect(
      furnaceCreateCommand(projectRoot, 'moz-preview-widget', { dryRun: true })
    ).rejects.toThrow(/already exists/);

    // Furnace config was not rewritten by the dry-run path.
    const afterContent = await readFile(join(projectRoot, 'furnace.json'), 'utf8');
    expect(afterContent).toContain('"description": "already here"');
  });

  it('does not scaffold test files even when --with-tests is set', async () => {
    // Pre-create the engine directory so the --with-tests path does not
    // bail out on the "engine dir not found" preflight. The dry-run must
    // still not write any test scaffolding into it.
    await mkdir(join(projectRoot, 'engine'), { recursive: true });

    await furnaceCreateCommand(projectRoot, 'moz-preview-widget', {
      description: 'Preview only',
      dryRun: true,
      withTests: true,
    });

    // Engine directory is still empty except for the pre-created root.
    const entries = await readdir(join(projectRoot, 'engine'));
    expect(entries).toEqual([]);
  });
});
