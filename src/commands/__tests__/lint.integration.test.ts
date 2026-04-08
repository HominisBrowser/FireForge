// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../core/config.js';
import { getAllDiff } from '../../core/git-diff.js';
import { extractAffectedFiles } from '../../core/patch-apply.js';
import { lintExportedPatch } from '../../core/patch-lint.js';
import {
  FIREFOX_WORKFLOW_FIXTURES,
  FIREFOX_WORKFLOW_SETUP_OPTIONS,
  generateLargeModule,
} from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import { lintCommand } from '../lint.js';
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
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('lint integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-lint-integration-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  // Helper to get lint issues directly (bypasses lintCommand's error/throw behavior)
  async function getLintIssues(
    engineDir: string
  ): Promise<import('../../types/commands/index.js').PatchLintIssue[]> {
    const diff = await getAllDiff(engineDir);
    const affectedFiles = extractAffectedFiles(diff);
    const config = await loadConfig(projectRoot);
    return lintExportedPatch(engineDir, affectedFiles, diff, config);
  }

  it('lint passes on a clean CSS file with valid tokens', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.cssDesignTokens;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/themes/shared/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    await expect(lintCommand(projectRoot, [fixture.exportPath])).resolves.toBeUndefined();
  });

  it('lint detects raw CSS color values as warning', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.cssRawColorViolation;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/themes/shared/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const colorIssues = issues.filter((i) => i.check === 'raw-color-value');
    expect(colorIssues.length).toBeGreaterThanOrEqual(1);
    expect(colorIssues[0]?.severity).toBe('warning');
  });

  it('lint detects CSS token-prefix violation as error', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.cssTokenPrefixViolation;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/themes/shared/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    // Write furnace.json so token-prefix check is active
    await writeFiles(projectRoot, {
      'furnace.json':
        JSON.stringify(
          {
            version: 1,
            componentPrefix: 'moz-',
            tokenPrefix: '--mybrowser-',
            tokenAllowlist: [
              '--background-color-box',
              '--text-color',
              '--text-color-deemphasized',
              '--button-background-color-hover',
            ],
            stock: [],
            overrides: {},
            custom: {},
          },
          null,
          2
        ) + '\n',
    });

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const prefixIssues = issues.filter((i) => i.check === 'token-prefix-violation');
    expect(prefixIssues.length).toBeGreaterThanOrEqual(1);
    expect(prefixIssues[0]?.severity).toBe('error');
  });

  it('lint detects missing license header as error', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    // lintCommand should throw because missing-license-header is severity: error
    await expect(lintCommand(projectRoot, [fixture.exportPath])).rejects.toThrow('error');
  });

  it('lint detects relative imports as error', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const importIssues = issues.filter((i) => i.check === 'relative-import');
    expect(importIssues.length).toBeGreaterThanOrEqual(1);
    expect(importIssues[0]?.severity).toBe('error');
  });

  it('lint detects missing JSDoc on new .sys.mjs exports', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const jsdocIssues = issues.filter((i) => i.check === 'missing-jsdoc');
    expect(jsdocIssues.length).toBeGreaterThanOrEqual(1);
    expect(jsdocIssues[0]?.severity).toBe('warning');
  });

  it('lint detects observer topic naming violation', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const topicIssues = issues.filter((i) => i.check === 'observer-topic-naming');
    expect(topicIssues.length).toBeGreaterThanOrEqual(1);
    expect(topicIssues[0]?.severity).toBe('warning');
  });

  it('lint detects missing modification comment on upstream JS', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.browserGlueMissingMarker;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const markerIssues = issues.filter((i) => i.check === 'missing-modification-comment');
    expect(markerIssues.length).toBeGreaterThanOrEqual(1);
    expect(markerIssues[0]?.severity).toBe('warning');
  });

  it('lint passes when modification comment is present', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.browserGlueIntegration;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const markerIssues = issues.filter((i) => i.check === 'missing-modification-comment');
    expect(markerIssues).toHaveLength(0);
  });

  it('lint warns on large new file exceeding 650 lines', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/LargeModule.sys.mjs': generateLargeModule(700),
    });

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const sizeIssues = issues.filter((i) => i.check === 'file-too-large');
    expect(sizeIssues.length).toBeGreaterThanOrEqual(1);
    expect(sizeIssues[0]?.severity).toBe('warning');
  });

  it('lint reports nothing when no changes exist', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/base/content/browser.js': 'export const title = "unchanged";\n',
    });

    // No modifications — should return without error
    await expect(lintCommand(projectRoot, [])).resolves.toBeUndefined();
  });

  it('lint passes on Rust file modification (non-JS/CSS gets no lint checks)', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.rustFileModification;
    await initCommittedRepo(join(projectRoot, 'engine'), fixture.initialFiles);
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    // Rust files should pass lint cleanly — no JS/CSS checks apply
    await expect(lintCommand(projectRoot, [fixture.exportPath])).resolves.toBeUndefined();
  });

  it('lint warns on CSS with proper header but raw colors in light-dark()', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.cssTokensWithRawColors;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/themes/shared/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));

    // Should have raw-color-value warning (light-dark(#hex) contains hex)
    const colorIssues = issues.filter((i) => i.check === 'raw-color-value');
    expect(colorIssues.length).toBeGreaterThanOrEqual(1);
    expect(colorIssues[0]?.severity).toBe('warning');

    // Should NOT have missing-license-header (header is present)
    const headerIssues = issues.filter((i) => i.check === 'missing-license-header');
    expect(headerIssues).toHaveLength(0);

    // lintCommand should NOT throw (warnings only, no errors)
    await expect(lintCommand(projectRoot, [fixture.exportPath])).resolves.toBeUndefined();
  });

  it('lint scoped to one file ignores violations in other files', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
      'browser/themes/shared/.gitkeep': '',
    });
    // Write one clean file and one file with violations
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/themes/shared/clean.css': [
        '/* SPDX-License-Identifier: EUPL-1.2 */',
        '',
        '.panel { display: flex; }',
        '',
      ].join('\n'),
      'browser/modules/mybrowser/Bad.sys.mjs':
        'import { x } from "./y.mjs";\nexport function f() {}\n',
    });

    // Lint only the clean file — should pass even though Bad.sys.mjs has violations
    await expect(
      lintCommand(projectRoot, ['browser/themes/shared/clean.css'])
    ).resolves.toBeUndefined();
  });

  it('lint accepts /* SPDX */ block-comment header in JS file', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.cssStyleHeaderInJsFile;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const headerIssues = issues.filter((i) => i.check === 'missing-license-header');
    expect(headerIssues).toHaveLength(0);
  });

  it('lint detects observer topic with inline string correctly', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.observerRegexEdgeCase;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    const issues = await getLintIssues(join(projectRoot, 'engine'));

    // The inline string topic "mybrowser-storage-started" follows convention, so no warning
    const topicIssues = issues.filter((i) => i.check === 'observer-topic-naming');
    for (const issue of topicIssues) {
      // Any matched topic should be a short string, not a multi-line code dump
      expect(issue.message.length).toBeLessThan(300);
    }
  });

  it('lint detects multiple issue types on a single file simultaneously', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    // File triggers: missing-license-header, relative-import, missing-jsdoc
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/Multi.sys.mjs': [
        'import { x } from "../utils.mjs";',
        '',
        'export function process() {',
        '  return x();',
        '}',
        '',
      ].join('\n'),
    });

    const issues = await getLintIssues(join(projectRoot, 'engine'));
    const checks = new Set(issues.map((i) => i.check));
    expect(checks.has('missing-license-header')).toBe(true);
    expect(checks.has('relative-import')).toBe(true);
    expect(checks.has('missing-jsdoc')).toBe(true);
  });
});
