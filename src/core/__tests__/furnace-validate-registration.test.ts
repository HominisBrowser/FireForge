// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn() };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({ engine: '/engine' })),
  loadConfig: vi.fn().mockResolvedValue({ binaryName: 'nightlyfox' }),
}));

vi.mock('../furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({ customDir: '/project/components/custom' })),
}));

vi.mock('../token-manager.js', () => ({
  getTokensCssPath: vi.fn((binaryName: string) => `chrome://browser/skin/${binaryName}.css`),
}));

import { readdir } from 'node:fs/promises';

import type { CustomComponentConfig, FurnaceConfig, StepError } from '../../types/furnace.js';
import { pathExists, readText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { loadConfig } from '../config.js';
import {
  checkRegistrationConsistency,
  runPostApplyConsistencyChecks,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateTokenLink,
} from '../furnace-validate-registration.js';

const COMPONENT_CONFIG: CustomComponentConfig = {
  description: 'Dock component',
  localized: false,
  register: true,
  targetPath: 'toolkit/content',
};

const LOCALIZED_CONFIG: CustomComponentConfig = {
  ...COMPONENT_CONFIG,
  localized: true,
};

const FTL_DEST = '/engine/toolkit/locales/en-US/toolkit/global/moz-dock.ftl';
const FTL_SRC = '/project/components/custom/moz-dock/moz-dock.ftl';

describe('furnace registration validation helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValue('');
  });

  it('returns an empty status when the source component directory is missing', async () => {
    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual({
      sourceExists: false,
      targetExists: false,
      filesInSync: true,
      jarMnCss: false,
      jarMnMjs: false,
      customElementsPresent: false,
      customElementsCorrectBlock: false,
      driftedFiles: [],
      missingTargetFiles: [],
    });
  });

  it('detects missing target files, drift, and registration placement', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          '/engine/toolkit/content/moz-dock.css',
          '/engine/toolkit/content/jar.mn',
          '/engine/toolkit/content/customElements.js',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: 'moz-dock.css' },
      { isFile: () => true, name: 'moz-dock.mjs' },
      { isFile: () => false, name: 'ignored-dir' },
    ] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('moz-dock.css')) return Promise.resolve('same-content');
      if (filePath.endsWith('moz-dock.mjs')) {
        return Promise.resolve(filePath.startsWith('/project/') ? 'src' : 'dest');
      }
      if (filePath.endsWith('jar.mn')) {
        return Promise.resolve('content/global/elements/moz-dock.css');
      }
      if (filePath.endsWith('customElements.js')) {
        return Promise.resolve(`
          customElements.setElementCreationCallback("moz-dock", () => {});
          document.addEventListener("DOMContentLoaded", () => {});
        `);
      }
      return Promise.resolve('');
    });

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        sourceExists: true,
        targetExists: true,
        filesInSync: false,
        jarMnCss: true,
        jarMnMjs: false,
        customElementsPresent: true,
        customElementsCorrectBlock: false,
        driftedFiles: [],
        missingTargetFiles: ['moz-dock.mjs'],
      })
    );
  });

  it('detects drifted files and correctly placed custom elements', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          '/engine/toolkit/content/moz-dock.css',
          '/engine/toolkit/content/moz-dock.mjs',
          '/engine/toolkit/content/jar.mn',
          '/engine/toolkit/content/customElements.js',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([{ isFile: () => true, name: 'moz-dock.mjs' }] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/project/components/custom/moz-dock/moz-dock.mjs') {
        return Promise.resolve('source');
      }
      if (filePath === '/engine/toolkit/content/moz-dock.mjs') return Promise.resolve('target');
      if (filePath.endsWith('jar.mn')) {
        return Promise.resolve(
          'content/global/elements/moz-dock.css\ncontent/global/elements/moz-dock.mjs'
        );
      }
      if (filePath.endsWith('customElements.js')) {
        return Promise.resolve(`
          document.addEventListener("DOMContentLoaded", () => {
            customElements.setElementCreationCallback("moz-dock", () => {});
          });
        `);
      }
      return Promise.resolve('');
    });

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        filesInSync: false,
        jarMnCss: true,
        jarMnMjs: true,
        customElementsPresent: true,
        customElementsCorrectBlock: true,
        driftedFiles: ['moz-dock.mjs'],
      })
    );
  });

  it('accepts Firefox 152 array-based custom element entries in consistency checks', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          '/engine/toolkit/content/moz-dock.mjs',
          '/engine/toolkit/content/jar.mn',
          '/engine/toolkit/content/customElements.js',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([{ isFile: () => true, name: 'moz-dock.mjs' }] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath.endsWith('moz-dock.mjs')) return Promise.resolve('same');
      if (filePath.endsWith('jar.mn')) {
        return Promise.resolve('content/global/elements/moz-dock.mjs');
      }
      if (filePath.endsWith('customElements.js')) {
        return Promise.resolve(
          [
            'const acornElements = [',
            '  ["moz-dock", "chrome://global/content/elements/moz-dock.mjs"],',
            '];',
            '',
            'document.addEventListener("DOMContentLoaded", () => {',
            '  for (const [tag, script] of acornElements) {',
            '    customElements.setElementCreationCallback(tag, () => {',
            '      ChromeUtils.importESModule(script);',
            '    });',
            '  }',
            '});',
            '',
          ].join('\n')
        );
      }
      return Promise.resolve('');
    });

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        customElementsPresent: true,
        customElementsCorrectBlock: true,
      })
    );
  });

  it('flags localized components whose .ftl is missing from the Fluent tree', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        ['/project/components/custom/moz-dock', '/engine/toolkit/content', FTL_SRC].includes(
          filePath
        )
      )
    );
    vi.mocked(readdir).mockResolvedValue([] as never);

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', LOCALIZED_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        sourceExists: true,
        targetExists: true,
        filesInSync: false,
        missingTargetFiles: ['moz-dock.ftl'],
        driftedFiles: [],
      })
    );
  });

  it('flags localized components whose deployed .ftl has drifted from source', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          FTL_SRC,
          FTL_DEST,
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === FTL_SRC) return Promise.resolve('source-ftl');
      if (filePath === FTL_DEST) return Promise.resolve('stale-ftl');
      return Promise.resolve('');
    });

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', LOCALIZED_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        filesInSync: false,
        driftedFiles: ['moz-dock.ftl'],
        missingTargetFiles: [],
      })
    );
  });

  it('treats localized components as in-sync when source and deployed .ftl match', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/project/components/custom/moz-dock',
          '/engine/toolkit/content',
          FTL_SRC,
          FTL_DEST,
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(readText).mockResolvedValue('same-ftl-body');

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', LOCALIZED_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        filesInSync: true,
        driftedFiles: [],
        missingTargetFiles: [],
      })
    );
  });

  it('ignores .ftl presence entirely for non-localized components', async () => {
    // A stray .ftl alongside a non-localized component's sources must not
    // cause the drift oracle to look for it in the Fluent tree.
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        ['/project/components/custom/moz-dock', '/engine/toolkit/content', FTL_SRC].includes(
          filePath
        )
      )
    );
    vi.mocked(readdir).mockResolvedValue([] as never);

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        filesInSync: true,
        driftedFiles: [],
        missingTargetFiles: [],
      })
    );
  });

  it('warns when tokenized component CSS is not linked from browser.xhtml', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        ['/component/moz-dock.css', '/engine/browser/base/content/browser.xhtml'].includes(filePath)
      )
    );
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/component/moz-dock.css') {
        return Promise.resolve('.dock { color: var(--ff-token-color); }');
      }
      return Promise.resolve('<html></html>');
    });

    await expect(
      validateTokenLink('/component', 'moz-dock', '/project', '--ff-token')
    ).resolves.toEqual([
      expect.objectContaining({
        component: 'moz-dock',
        check: 'missing-token-link',
        severity: 'warning',
      }),
    ]);
  });

  it('auto-detects a replacement chrome document that references the component tag', async () => {
    // Fork mounts moz-dock from a custom `mybrowser.xhtml` chrome document
    // WITHOUT configuring tokenHostDocuments. The default scan set (only
    // browser.xhtml) does not link the tokens CSS, but the custom document
    // does — auto-detection adds it to the scan set and the warning is
    // suppressed.
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/component/moz-dock.css',
          '/engine/browser/base/content',
          '/engine/browser/base/content/browser.xhtml',
          '/engine/browser/base/content/mybrowser.xhtml',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue([
      'browser.xhtml',
      'mybrowser.xhtml',
      'something-unrelated.js',
    ] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/component/moz-dock.css') {
        return Promise.resolve('.dock { color: var(--ff-token-color); }');
      }
      if (filePath === '/engine/browser/base/content/browser.xhtml') {
        // Upstream document does not mount moz-dock and does not link tokens.
        return Promise.resolve('<window><html:body></html:body></window>');
      }
      if (filePath === '/engine/browser/base/content/mybrowser.xhtml') {
        // Replacement document mounts moz-dock AND links the tokens CSS.
        return Promise.resolve(
          '<window><link rel="stylesheet" href="nightlyfox.css" /><moz-dock></moz-dock></window>'
        );
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink('/component', 'moz-dock', '/project', '--ff-token');
    expect(issues.filter((i) => i.check === 'missing-token-link')).toEqual([]);
  });

  it('still warns when auto-detected hosts also lack the tokens CSS link', async () => {
    // A chrome document references the tag but does NOT link the tokens CSS,
    // and no other document does either. The warning fires and names both
    // the configured default AND the auto-detected document so the operator
    // can see where to add the link.
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/component/moz-dock.css',
          '/engine/browser/base/content',
          '/engine/browser/base/content/browser.xhtml',
          '/engine/browser/base/content/mybrowser.xhtml',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue(['browser.xhtml', 'mybrowser.xhtml'] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/component/moz-dock.css') {
        return Promise.resolve('.dock { color: var(--ff-token-color); }');
      }
      if (filePath.endsWith('mybrowser.xhtml')) {
        return Promise.resolve('<window><moz-dock></moz-dock></window>');
      }
      return Promise.resolve('<window></window>');
    });

    const issues = await validateTokenLink('/component', 'moz-dock', '/project', '--ff-token');
    const tokenIssues = issues.filter((i) => i.check === 'missing-token-link');
    expect(tokenIssues).toHaveLength(1);
    expect(tokenIssues[0]?.message).toContain('browser/base/content/browser.xhtml');
    expect(tokenIssues[0]?.message).toContain('browser/base/content/mybrowser.xhtml');
  });

  it('does not double-scan a document listed in tokenHostDocuments that also mentions the tag', async () => {
    // When the operator explicitly configures tokenHostDocuments AND the
    // same document happens to mention the component tag, the auto-detect
    // path must not add a duplicate entry that would render twice in the
    // warning list.
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(
        [
          '/component/moz-dock.css',
          '/engine/browser/base/content',
          '/engine/browser/base/content/mybrowser.xhtml',
        ].includes(filePath)
      )
    );
    vi.mocked(readdir).mockResolvedValue(['mybrowser.xhtml'] as never);
    vi.mocked(readText).mockImplementation((filePath: string) => {
      if (filePath === '/component/moz-dock.css') {
        return Promise.resolve('.dock { color: var(--ff-token-color); }');
      }
      if (filePath.endsWith('mybrowser.xhtml')) {
        return Promise.resolve('<window><moz-dock></moz-dock></window>');
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink('/component', 'moz-dock', '/project', '--ff-token', [
      'browser/base/content/mybrowser.xhtml',
    ]);
    const tokenIssues = issues.filter((i) => i.check === 'missing-token-link');
    expect(tokenIssues).toHaveLength(1);
    // The same path must appear exactly once in the rendered list.
    const mentions =
      tokenIssues[0]?.message.split('browser/base/content/mybrowser.xhtml').length ?? 0;
    expect(mentions - 1).toBe(1);
  });

  describe('validateJarMnEntries', () => {
    const baseConfig: FurnaceConfig = {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-dock': {
          description: 'Dock',
          targetPath: 'toolkit/content',
          register: true,
          localized: false,
        },
      },
    };

    it('does not warn about missing CSS entry when the source has no CSS file', async () => {
      // Regression for the false positive that warned for every registered
      // custom component regardless of whether the component had a .css file.
      vi.mocked(pathExists).mockImplementation((filePath: string) => {
        // jar.mn exists; component CSS source does NOT.
        if (filePath === '/engine/toolkit/content/jar.mn') return Promise.resolve(true);
        return Promise.resolve(false);
      });
      vi.mocked(readText).mockResolvedValue('content/global/elements/moz-dock.mjs');

      const issues = await validateJarMnEntries('/project', baseConfig);

      expect(issues.some((i) => i.check === 'missing-jar-mn-css')).toBe(false);
      expect(issues.some((i) => i.check === 'missing-jar-mn-mjs')).toBe(false);
    });

    it('still warns about missing CSS entry when the source has a CSS file', async () => {
      vi.mocked(pathExists).mockImplementation((filePath: string) => {
        if (filePath === '/engine/toolkit/content/jar.mn') return Promise.resolve(true);
        if (filePath === '/project/components/custom/moz-dock/moz-dock.css') {
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      });
      vi.mocked(readText).mockResolvedValue('content/global/elements/moz-dock.mjs');

      const issues = await validateJarMnEntries('/project', baseConfig);

      const cssWarning = issues.find((i) => i.check === 'missing-jar-mn-css');
      expect(cssWarning).toBeDefined();
      expect(cssWarning?.severity).toBe('warning');
    });

    it('errors when the .mjs entry is missing regardless of CSS presence', async () => {
      vi.mocked(pathExists).mockImplementation((filePath: string) => {
        if (filePath === '/engine/toolkit/content/jar.mn') return Promise.resolve(true);
        return Promise.resolve(false);
      });
      vi.mocked(readText).mockResolvedValue('# empty jar');

      const issues = await validateJarMnEntries('/project', baseConfig);

      const mjsError = issues.find((i) => i.check === 'missing-jar-mn-mjs');
      expect(mjsError).toBeDefined();
      expect(mjsError?.severity).toBe('error');
    });

    it('flags stale registrations pointing at removed component files (0.34.0)', async () => {
      vi.mocked(pathExists).mockImplementation((filePath: string) => {
        if (filePath === '/engine/toolkit/content/jar.mn') return Promise.resolve(true);
        if (filePath === '/project/components/custom/moz-dock/moz-dock.mjs') {
          return Promise.resolve(true);
        }
        // The renamed-away helper no longer exists in the workspace.
        return Promise.resolve(false);
      });
      vi.mocked(readText).mockResolvedValue(
        [
          '   content/global/elements/moz-dock.mjs  (widgets/moz-dock/moz-dock.mjs)',
          '   content/global/elements/old-helper.mjs  (widgets/moz-dock/old-helper.mjs)',
        ].join('\n')
      );

      const issues = await validateJarMnEntries('/project', baseConfig);

      const stale = issues.filter((i) => i.check === 'stale-jar-registration');
      expect(stale).toHaveLength(1);
      expect(stale[0]?.severity).toBe('error');
      expect(stale[0]?.component).toBe('moz-dock');
      expect(stale[0]?.message).toContain('old-helper.mjs');
    });

    it('does not flag live registrations as stale', async () => {
      vi.mocked(pathExists).mockImplementation((filePath: string) => {
        if (filePath === '/engine/toolkit/content/jar.mn') return Promise.resolve(true);
        if (filePath.startsWith('/project/components/custom/moz-dock/')) {
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      });
      vi.mocked(readText).mockResolvedValue(
        '   content/global/elements/moz-dock.mjs  (widgets/moz-dock/moz-dock.mjs)'
      );

      const issues = await validateJarMnEntries('/project', baseConfig);
      expect(issues.some((i) => i.check === 'stale-jar-registration')).toBe(false);
    });
  });

  it('reports filesInSync false when source exists but target does not', async () => {
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath === '/project/components/custom/moz-dock')
    );
    vi.mocked(readdir).mockResolvedValue([{ isFile: () => true, name: 'moz-dock.mjs' }] as never);

    await expect(
      checkRegistrationConsistency('/project', 'moz-dock', COMPONENT_CONFIG)
    ).resolves.toEqual(
      expect.objectContaining({
        sourceExists: true,
        targetExists: false,
        filesInSync: false,
      })
    );
  });

  describe('validateRegistrationPatterns', () => {
    const baseConfig: FurnaceConfig = {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-dock': {
          description: 'Dock',
          targetPath: 'toolkit/content',
          register: true,
          localized: false,
        },
      },
    };

    it('returns empty when customElements.js does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);

      const issues = await validateRegistrationPatterns('/project', baseConfig);
      expect(issues).toEqual([]);
    });

    it('reports a registered component that the file never mentions (0.41.0)', async () => {
      // This used to expect [] — which is exactly the blind spot that made a
      // registration-only defect invisible to validate and unreachable for
      // the scoped `--fix`.
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readText).mockResolvedValue('// no DCL listener here');

      const issues = await validateRegistrationPatterns('/project', baseConfig);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.check).toBe('missing-custom-element-registration');
    });

    it('finds a component registered in the wrong (before-DCL) block', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readText).mockResolvedValue(
        `customElements.setElementCreationCallback("moz-dock", () => {});\n` +
          `document.addEventListener("DOMContentLoaded", () => {\n` +
          `  // lazy components here\n` +
          `});\n`
      );

      const issues = await validateRegistrationPatterns('/project', baseConfig);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual(
        expect.objectContaining({
          component: 'moz-dock',
          check: 'wrong-registration-pattern',
          severity: 'error',
        })
      );
    });

    it('accepts Firefox 152 array declared before DOMContentLoaded and consumed inside it', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(readText).mockResolvedValue(
        [
          'const acornElements = [',
          '  ["moz-dock", "chrome://global/content/elements/moz-dock.mjs"],',
          '];',
          '',
          'document.addEventListener("DOMContentLoaded", () => {',
          '  for (let [tag, script] of acornElements) {',
          '    customElements.setElementCreationCallback(tag, () => {',
          '      ChromeUtils.importESModule(script);',
          '    });',
          '  }',
          '});',
          '',
        ].join('\n')
      );

      const issues = await validateRegistrationPatterns('/project', baseConfig);
      expect(issues).toEqual([]);
    });
  });

  describe('runPostApplyConsistencyChecks', () => {
    const customConfig: Record<string, CustomComponentConfig> = {
      'moz-dock': {
        description: 'Dock',
        targetPath: 'toolkit/content',
        register: true,
        localized: false,
      },
    };

    it('adds step error when customElements registration is missing', async () => {
      // Source exists, target exists, jar.mn has .mjs entry, but customElements.js has no mention
      vi.mocked(pathExists).mockImplementation((filePath: string) =>
        Promise.resolve(
          [
            '/project/components/custom/moz-dock',
            '/engine/toolkit/content',
            '/engine/toolkit/content/jar.mn',
          ].includes(filePath)
        )
      );
      vi.mocked(readdir).mockResolvedValue([] as never);
      vi.mocked(readText).mockImplementation((filePath: string) => {
        if (filePath.endsWith('jar.mn')) {
          return Promise.resolve('content/global/elements/moz-dock.mjs');
        }
        return Promise.resolve('');
      });

      const result: { applied: Array<{ name: string; stepErrors?: StepError[] }> } = {
        applied: [{ name: 'moz-dock' }],
      };
      await runPostApplyConsistencyChecks(
        '/project',
        { custom: customConfig },
        result,
        'toolkit/locales/en-US/toolkit/global'
      );

      expect(result.applied[0]).toHaveProperty('stepErrors');
      expect(result.applied[0]?.stepErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: 'post-apply consistency',
            error: expect.stringContaining('missing customElements.js registration') as string,
          }),
        ])
      );
    });

    it('adds step error when jar.mn .mjs entry is missing', async () => {
      // Source exists, target exists, customElements.js has the tag, but jar.mn does not have .mjs
      vi.mocked(pathExists).mockImplementation((filePath: string) =>
        Promise.resolve(
          [
            '/project/components/custom/moz-dock',
            '/engine/toolkit/content',
            '/engine/toolkit/content/customElements.js',
          ].includes(filePath)
        )
      );
      vi.mocked(readdir).mockResolvedValue([] as never);
      vi.mocked(readText).mockImplementation((filePath: string) => {
        if (filePath.endsWith('customElements.js')) {
          return Promise.resolve(
            `document.addEventListener("DOMContentLoaded", () => {\n` +
              `  customElements.setElementCreationCallback("moz-dock", () => {});\n` +
              `});\n`
          );
        }
        return Promise.resolve('');
      });

      const result: { applied: Array<{ name: string; stepErrors?: StepError[] }> } = {
        applied: [{ name: 'moz-dock' }],
      };
      await runPostApplyConsistencyChecks(
        '/project',
        { custom: customConfig },
        result,
        'toolkit/locales/en-US/toolkit/global'
      );

      expect(result.applied[0]?.stepErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: 'post-apply consistency',
            error: expect.stringContaining('missing jar.mn .mjs entry') as string,
          }),
        ])
      );
    });

    it('skips components not in the applied list', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);

      const result = { applied: [{ name: 'moz-other' }] };
      await runPostApplyConsistencyChecks(
        '/project',
        { custom: customConfig },
        result,
        'toolkit/locales/en-US/toolkit/global'
      );

      expect(result.applied[0]).not.toHaveProperty('stepErrors');
    });

    it('silently catches errors thrown by checkRegistrationConsistency', async () => {
      // Force pathExists to throw on the source-exists check
      vi.mocked(pathExists).mockRejectedValue(new Error('disk failure'));

      const result = { applied: [{ name: 'moz-dock' }] };

      // Should not throw
      await expect(
        runPostApplyConsistencyChecks(
          '/project',
          { custom: customConfig },
          result,
          'toolkit/locales/en-US/toolkit/global'
        )
      ).resolves.toBeUndefined();

      expect(result.applied[0]).not.toHaveProperty('stepErrors');
    });
  });

  it('returns no token-link issues when config lookup fails or prerequisites are absent', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('.dock { color: var(--ff-token-color); }');
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('broken config'));

    await expect(
      validateTokenLink('/component', 'moz-dock', '/project', '--ff-token')
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Could not resolve token CSS link target for moz-dock during validation: broken config'
    );
    await expect(validateTokenLink('/component', 'moz-dock', '/project')).resolves.toEqual([]);
  });
});
