// SPDX-License-Identifier: EUPL-1.2
/**
 * The four 0.46.0 audit skip classes, against a downstream-shaped objdir.
 *
 * A successful fork build printed seven `Audit:` warnings and a
 * `4 missing` summary with zero real misses. The audit is warn-only, so
 * each false positive is cheap alone and ruinous in aggregate: an operator
 * who learns these lines are usually wrong stops reading the one that is
 * right. The bar here is therefore ZERO warnings for the whole fixture,
 * plus per-class counts an operator can check — and a negative control per
 * class, because a classifier that skips unconditionally would also pass a
 * zero-warnings assertion.
 *
 * The host platform is pinned to darwin: the `WINNT` gate that excludes
 * `toolkit/mozapps/defaultagent` is off-host on macOS and Linux but not on
 * the Windows runner, which runs this suite too.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../patch-manifest-io.js', () => ({
  loadPatchesManifest: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../utils/platform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/platform.js')>()),
  getPlatform: vi.fn(() => 'darwin'),
}));

import { ensureDir, writeText } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { auditBuildArtifacts } from '../build-audit.js';
import * as git from '../git.js';
import * as gitBase from '../git-base.js';
import * as gitStatus from '../git-status.js';

const UNSELECTED_BRANDING = 'browser/branding/testbrowser-unbranded/content/aboutDialog.css';
const UNSELECTED_BRANDING_PREF = 'browser/branding/testbrowser-unbranded/pref/firefox-branding.js';
const ANCESTOR_GATED = 'toolkit/mozapps/defaultagent/BackgroundTask_defaultagent.sys.mjs';
const STORY = 'browser/components/aiwindow/ui/components/promo/promo.stories.mjs';
const TYPE_MIRROR = 'browser/base/content/hominis-tile-host-types.js';

const ALL_CHANGED = [
  UNSELECTED_BRANDING,
  UNSELECTED_BRANDING_PREF,
  ANCESTOR_GATED,
  STORY,
  TYPE_MIRROR,
];

/**
 * The nested shape Firefox actually uses: `toolkit/mozapps/defaultagent`
 * is reached only through a `DIRS +=` three conditionals deep, and it is
 * the OUTERMOST (`OS_ARCH == "WINNT"`) that excludes it off-Windows.
 * Nothing in the directory's own moz.build says so.
 */
const TOOLKIT_MOZ_BUILD = `DIRS += [
    "components",
    "modules",
]

if CONFIG["OS_ARCH"] == "WINNT":
    if CONFIG["CC_TYPE"] == "clang-cl" or CONFIG["MOZ_ARTIFACT_BUILDS"]:
        if CONFIG["MOZ_DEFAULT_BROWSER_AGENT"]:
            DIRS += ["mozapps/defaultagent"]
`;

const DECLARATION = {
  path: TYPE_MIRROR,
  reason: 'Type-only mirror of the tile host; never loaded, carries no jar.mn entry by design.',
};

let engineDir: string;

/** Builds the fake objdir and pins the changed-path set. */
async function seed(options: { withBranding?: boolean } = {}): Promise<void> {
  await ensureDir(join(engineDir, 'obj-debug', 'dist'));
  const brandingLine =
    options.withBranding === false
      ? ''
      : 'ac_add_options --with-branding=browser/branding/testbrowser\n';
  await writeText(
    join(engineDir, 'mozconfig'),
    `ac_add_options --enable-optimize\n${brandingLine}`
  );

  await ensureDir(join(engineDir, 'browser/branding/testbrowser/content'));
  await writeText(join(engineDir, 'browser/branding/testbrowser/content/aboutDialog.css'), 'a{}');
  for (const path of ALL_CHANGED) {
    await ensureDir(join(engineDir, path.slice(0, path.lastIndexOf('/'))));
    await writeText(join(engineDir, path), '// x\n');
  }
  await writeText(join(engineDir, 'toolkit', 'moz.build'), TOOLKIT_MOZ_BUILD);
  await writeText(
    join(engineDir, 'toolkit/mozapps/defaultagent', 'moz.build'),
    'JAR_MANIFESTS = []\n'
  );

  vi.spyOn(git, 'hasChanges').mockResolvedValue(true);
  vi.spyOn(gitStatus, 'getUntrackedFiles').mockResolvedValue([...ALL_CHANGED]);
  vi.spyOn(gitBase, 'git').mockResolvedValue('');
}

beforeEach(async () => {
  engineDir = await mkdtemp(join(tmpdir(), 'ff-audit-classes-'));
  vi.mocked(warn).mockClear();
  vi.mocked(info).mockClear();
});

afterEach(async () => {
  await rm(engineDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('post-build audit skip classes', () => {
  it('emits zero warnings and counts each class separately', async () => {
    await seed();
    const summary = await auditBuildArtifacts('/project', engineDir, undefined, {
      unpackaged: [DECLARATION],
    });

    expect(vi.mocked(warn).mock.calls.map((c) => c[0])).toEqual([]);
    expect(summary.missing).toBe(0);
    expect(summary.stale).toBe(0);
    expect(summary.skipped).toBe(ALL_CHANGED.length);
    expect(summary.skippedByReason).toMatchObject({
      'branding-not-selected': 2,
      'platform-gated-ancestor': 1,
      'storybook-story': 1,
      'declared-unpackaged': 1,
    });
  });

  it('names every non-zero class on the Packaged: line', async () => {
    // The `4 missing` a fork saw had no counterpart in the counts an
    // operator could check; the breakdown is what makes it checkable.
    await seed();
    await auditBuildArtifacts('/project', engineDir, undefined, { unpackaged: [DECLARATION] });
    const packagedLine = vi
      .mocked(info)
      .mock.calls.map((c) => c[0])
      .find((line) => line.startsWith('Packaged:'));
    expect(packagedLine).toContain('branding-not-selected 2');
    expect(packagedLine).toContain('platform-gated-ancestor 1');
    expect(packagedLine).toContain('storybook-story 1');
    expect(packagedLine).toContain('declared-unpackaged 1');
  });

  it('LISTS an admitted path rather than silencing it', async () => {
    // A carve-out nobody can see is how one quietly widens.
    await seed();
    await auditBuildArtifacts('/project', engineDir, undefined, { unpackaged: [DECLARATION] });
    const notices = vi
      .mocked(info)
      .mock.calls.map((c) => c[0])
      .join('\n');
    expect(notices).toContain('admitted as unpackaged');
    expect(notices).toContain(TYPE_MIRROR);
    expect(notices).toContain('never loaded');
  });

  describe('negative controls', () => {
    it('warns about the type mirror again once the declaration is removed', async () => {
      await seed();
      const summary = await auditBuildArtifacts('/project', engineDir, undefined);
      const warnings = vi
        .mocked(warn)
        .mock.calls.map((c) => c[0])
        .join('\n');
      expect(warnings).toContain(TYPE_MIRROR);
      expect(summary.missing).toBe(1);
      expect(summary.skippedByReason['declared-unpackaged']).toBe(0);
    });

    it('warns about the unselected branding again once the mozconfig cannot name the selection', async () => {
      // A skip that cannot name its evidence is a masked warning, so an
      // unreadable branding directive must restore the old behaviour.
      await seed({ withBranding: false });
      const summary = await auditBuildArtifacts('/project', engineDir, undefined, {
        unpackaged: [DECLARATION],
      });
      const warnings = vi
        .mocked(warn)
        .mock.calls.map((c) => c[0])
        .join('\n');
      expect(warnings).toContain(UNSELECTED_BRANDING);
      expect(summary.skippedByReason['branding-not-selected']).toBe(0);
    });

    it('warns about the gated directory again when no ancestor moz.build gates it', async () => {
      await seed();
      await writeText(
        join(engineDir, 'toolkit', 'moz.build'),
        'DIRS += ["mozapps/defaultagent"]\n'
      );
      const summary = await auditBuildArtifacts('/project', engineDir, undefined, {
        unpackaged: [DECLARATION],
      });
      const warnings = vi
        .mocked(warn)
        .mock.calls.map((c) => c[0])
        .join('\n');
      expect(warnings).toContain(ANCESTOR_GATED);
      expect(summary.skippedByReason['platform-gated-ancestor']).toBe(0);
    });
  });

  it('reports an admitted path that DOES resolve to an artifact as a stale carve-out', async () => {
    // The declaration asserts a fact about the tree. When it stops being
    // true, suppressing on it would hide a real packaging change.
    await seed();
    await ensureDir(join(engineDir, 'obj-debug', 'dist', 'chrome/browser/content/browser'));
    await writeText(
      join(
        engineDir,
        'obj-debug/dist/chrome/browser/content/browser',
        'hominis-tile-host-types.js'
      ),
      '// x\n'
    );
    const summary = await auditBuildArtifacts('/project', engineDir, undefined, {
      unpackaged: [DECLARATION],
    });
    const warnings = vi
      .mocked(warn)
      .mock.calls.map((c) => c[0])
      .join('\n');
    expect(warnings).toContain('declaration is stale');
    expect(warnings).toContain(TYPE_MIRROR);
    expect(summary.skippedByReason['declared-unpackaged']).toBe(1);
  });
});
