// SPDX-License-Identifier: EUPL-1.2
/**
 * Git reports a wholly untracked directory as a single `?? dir/` entry
 * instead of listing the files under it. The guard passed raw status
 * entries to the classifier, a directory has no content to match against
 * a patch body or the pristine baseline, and so every untracked branding
 * subdirectory classified `unmanaged` and got named on every build —
 * while `fireforge status --unmanaged` (which expands) called the same
 * tree clean. `--refuse-unexported-drift` therefore hard-failed every
 * scripted build on such a checkout.
 *
 * These tests run against a REAL git repository on purpose: git's
 * collapsing is the trigger, and it only happens when the WHOLE directory
 * is untracked. A fixture whose untracked files sit beside a tracked
 * sibling produces per-file entries, classifies fine, and never exercises
 * the path that shipped broken.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FireForgeConfig } from '../../types/config.js';
import { exec } from '../../utils/process.js';
import { findUnexportedDriftAtRisk } from '../build-overwrite-guard.js';
import { getWorkingTreeStatus } from '../git-status.js';

const BINARY_NAME = 'testbrowser';
const BRANDING_ROOT = `browser/branding/${BINARY_NAME}`;
const config = { binaryName: BINARY_NAME } as FireForgeConfig;

const cleanupPaths: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Writes a file, creating its parent directories. */
async function writeFileAt(root: string, relative: string, content: string): Promise<void> {
  const target = join(root, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

/**
 * Builds a project whose `engine/` is a real git checkout with committed
 * files (so HEAD exists and untracked siblings collapse) and whose
 * `patches/` manifest claims `claimedFiles`. `tracked` pins where git
 * collapses: git collapses at the HIGHEST wholly untracked directory, so
 * committing a file inside the branding root keeps the collapse at the
 * subdirectory level the consumer observed.
 */
async function createProject(
  prefix: string,
  options: { untracked: Record<string, string>; claimedFiles: string[]; tracked?: string[] }
): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), `fireforge-drift-guard-${prefix}-`));
  cleanupPaths.push(projectRoot);

  const engineDir = join(projectRoot, 'engine');
  await mkdir(engineDir, { recursive: true });
  await exec('git', ['init'], { cwd: engineDir });
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: engineDir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: engineDir });
  await writeFileAt(engineDir, 'browser/base/tabs.js', '// pristine\n');
  for (const relative of options.tracked ?? []) {
    await writeFileAt(engineDir, relative, '# pristine\n');
  }
  await exec('git', ['add', '-A'], { cwd: engineDir });
  await exec('git', ['commit', '-m', 'baseline'], { cwd: engineDir });

  for (const [relative, content] of Object.entries(options.untracked)) {
    await writeFileAt(engineDir, relative, content);
  }

  const patchesDir = join(projectRoot, 'patches');
  await mkdir(patchesDir, { recursive: true });
  await writeFile(
    join(patchesDir, 'patches.json'),
    JSON.stringify({
      version: 1,
      patches: [
        {
          filename: '001-branding-assets.patch',
          name: 'branding-assets',
          description: 'Branding assets',
          createdAt: '2026-08-20T00:00:00.000Z',
          sourceVersion: '153.0esr',
          order: 1,
          category: 'branding',
          filesAffected: options.claimedFiles,
        },
      ],
    })
  );

  return projectRoot;
}

/** Asserts the fixture really reproduces git's collapsing. */
async function expectCollapsedDirectory(projectRoot: string, dir: string): Promise<void> {
  const status = await getWorkingTreeStatus(join(projectRoot, 'engine'));
  expect(status.map((entry) => entry.file)).toContain(dir);
}

describe('findUnexportedDriftAtRisk on collapsed untracked directories', () => {
  it('does not report a wholly untracked directory whose files are all recorded', async () => {
    const claimed = [
      `${BRANDING_ROOT}/content/about-logo.svg`,
      `${BRANDING_ROOT}/content/icon.svg`,
    ];
    const projectRoot = await createProject('recorded', {
      untracked: Object.fromEntries(claimed.map((file) => [file, '<svg/>\n'])),
      claimedFiles: claimed,
      tracked: [`${BRANDING_ROOT}/configure.sh`],
    });

    await expectCollapsedDirectory(projectRoot, `${BRANDING_ROOT}/content/`);

    await expect(findUnexportedDriftAtRisk(projectRoot, config)).resolves.toEqual([]);
  });

  it('still reports a genuinely unmanaged file inside the same collapsed directory', async () => {
    const claimed = [`${BRANDING_ROOT}/content/about-logo.svg`];
    const projectRoot = await createProject('unmanaged', {
      untracked: {
        [`${BRANDING_ROOT}/content/about-logo.svg`]: '<svg/>\n',
        [`${BRANDING_ROOT}/content/scratch-notes.txt`]: 'local experiment\n',
      },
      claimedFiles: claimed,
      tracked: [`${BRANDING_ROOT}/configure.sh`],
    });

    await expectCollapsedDirectory(projectRoot, `${BRANDING_ROOT}/content/`);

    const atRisk = await findUnexportedDriftAtRisk(projectRoot, config);

    expect(atRisk).toEqual([
      {
        file: `${BRANDING_ROOT}/content/scratch-notes.txt`,
        classification: 'unmanaged',
        owner: undefined,
      },
    ]);
  });

  it('walks only the owned subtree of a collapsed ancestor directory', async () => {
    // The whole branding tree is untracked, so git collapses ABOVE the
    // build-prepare-owned prefix: `?? browser/branding/`.
    const claimed = [`${BRANDING_ROOT}/content/about-logo.svg`];
    const projectRoot = await createProject('ancestor', {
      untracked: {
        [`${BRANDING_ROOT}/content/about-logo.svg`]: '<svg/>\n',
        [`${BRANDING_ROOT}/pref/scratch.js`]: 'pref("local.only", true);\n',
        // A sibling branding tree build-prepare does NOT rewrite.
        'browser/branding/otherbrowser/content/logo.svg': '<svg/>\n',
      },
      claimedFiles: claimed,
    });

    await expectCollapsedDirectory(projectRoot, 'browser/branding/');

    const atRisk = await findUnexportedDriftAtRisk(projectRoot, config);

    expect(atRisk.map((entry) => entry.file)).toEqual([`${BRANDING_ROOT}/pref/scratch.js`]);
  });
});
