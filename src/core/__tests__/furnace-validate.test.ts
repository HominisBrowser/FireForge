// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  validateAccessibility,
  validateCompatibility,
  validateJarMnEntries,
  validateRegistrationPatterns,
  validateTokenLink,
} from '../furnace-validate-checks.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'Test Browser',
      vendor: 'Test',
      appId: 'org.test.browser',
      binaryName: 'testbrowser',
      firefox: { version: '145.0', product: 'firefox' },
    })
  ),
}));

vi.mock('../furnace-config.js', () => ({
  getFurnacePaths: vi.fn(() => ({
    configPath: '/project/furnace.json',
    componentsDir: '/project/components',
    customDir: '/project/components/custom',
    overridesDir: '/project/components/overrides',
  })),
  loadFurnaceConfig: vi.fn(),
}));

import type { FurnaceConfig } from '../../types/furnace.js';
import { pathExists, readText } from '../../utils/fs.js';

const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateAccessibility', () => {
  it('passes when role is set via static attribute in template', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<div role="banner">content</div>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const roleIssues = issues.filter((i) => i.check === 'no-aria-role');
    expect(roleIssues).toHaveLength(0);
  });

  it('passes when role is set via .role property assignment', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        connectedCallback() {
          super.connectedCallback();
          this.role = "banner";
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const roleIssues = issues.filter((i) => i.check === 'no-aria-role');
    expect(roleIssues).toHaveLength(0);
  });

  it('passes when role is set via setAttribute("role")', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        connectedCallback() {
          super.connectedCallback();
          if (!this.getAttribute("role")) {
            this.setAttribute("role", "banner");
          }
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const roleIssues = issues.filter((i) => i.check === 'no-aria-role');
    expect(roleIssues).toHaveLength(0);
  });

  it('does not warn when native semantic markup provides accessibility semantics', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`
            <nav data-l10n-id="primary-navigation">
              <a href="about:preferences" data-l10n-id="settings-link"></a>
              <button data-l10n-id="open-settings"></button>
            </nav>
          \`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const roleIssues = issues.filter((i) => i.check === 'no-aria-role');
    expect(roleIssues).toHaveLength(0);
  });

  it('does not warn for named section semantics without explicit ARIA role', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`
            <section aria-label="Downloads">
              <button data-l10n-id="open-downloads"></button>
            </section>
          \`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const roleIssues = issues.filter((i) => i.check === 'no-aria-role');
    expect(roleIssues).toHaveLength(0);
  });

  it('warns when generic clickable markup has no role', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<div @click=\${() => doSomething()} tabindex="0">Open</div>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const roleIssues = issues.filter((i) => i.check === 'no-aria-role');
    expect(roleIssues).toHaveLength(1);
    expect(roleIssues[0]?.severity).toBe('warning');
  });

  it('warns when @click on synthetic interactive markup lacks a keyboard handler', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<div role="button" tabindex="0" @click=\${() => doSomething()}>Open</div>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-keyboard-handler')).toBe(true);
  });

  it('does not warn when @click sits on a native interactive element', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        static shadowRootOptions = { mode: 'open', delegatesFocus: true };

        render() {
          return html\`<button @click=\${() => doSomething()}>Open</button>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-keyboard-handler')).toBe(false);
  });

  it('does not warn when @click sits on an anchor with href', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        static shadowRootOptions = { mode: 'open', delegatesFocus: true };

        render() {
          return html\`<a href="#next" @click=\${() => doSomething()}>Next</a>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-keyboard-handler')).toBe(false);
  });

  it('warns when @click sits on a bare anchor without href', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<a role="button" @click=\${() => doSomething()}>Next</a>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-keyboard-handler')).toBe(true);
  });

  it('does not warn when @click sits on a moz-button', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        static shadowRootOptions = { mode: 'open', delegatesFocus: true };

        render() {
          return html\`<moz-button @click=\${() => doSomething()}>Open</moz-button>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-keyboard-handler')).toBe(false);
  });

  it('does not warn when click handlers are paired with keyboard handlers and delegatesFocus', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        static shadowRootOptions = { mode: 'open', delegatesFocus: true };

        render() {
          return html\`
            <button @click=\${() => doSomething()} @keydown=\${() => doSomething()}>Open</button>
          \`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-keyboard-handler')).toBe(false);
    expect(issues.some((issue) => issue.check === 'no-delegates-focus')).toBe(false);
  });

  it('warns when an interactive component lacks delegatesFocus', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<button @keydown=\${() => doSomething()}>Open</button>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'no-delegates-focus')).toBe(true);
  });

  it('warns when a positive tabindex is used', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<div tabindex="3">Content</div>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'positive-tabindex')).toBe(true);
  });

  it('does not warn for tabindex="0" or tabindex="-1"', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`
            <div tabindex="0">Focusable</div>
            <div tabindex="-1">Programmatic</div>
          \`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'positive-tabindex')).toBe(false);
  });

  it('warns when a form input has no accessible label', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<input type="text" />\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'unlabelled-form-input')).toBe(true);
  });

  it('does not warn for inputs with aria-label', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<input type="text" aria-label="Search" />\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'unlabelled-form-input')).toBe(false);
  });

  it('ignores symbol-only text nodes when checking for hardcoded text', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<span>⚙️</span>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    expect(issues.some((issue) => issue.check === 'hardcoded-text')).toBe(false);
  });
});

describe('validateCompatibility', () => {
  const baseConfig: FurnaceConfig = {
    version: 1,
    componentPrefix: 'moz-',
    tokenPrefix: '--mybrowser-',
    tokenAllowlist: [],
    stock: [],
    overrides: {
      'moz-card': {
        type: 'css-only',
        description: 'Override card styles',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
    },
    custom: {},
  };

  it('allows stock token references that already exist in the original override CSS', async () => {
    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/components/overrides/moz-card/moz-card.css' ||
          path === '/project/engine/toolkit/content/widgets/moz-card/moz-card.css'
      )
    );
    mockReadText.mockImplementation((path: string) => {
      if (path === '/components/overrides/moz-card/moz-card.css') {
        return Promise.resolve(':host { border: var(--card-border); }');
      }
      if (path === '/project/engine/toolkit/content/widgets/moz-card/moz-card.css') {
        return Promise.resolve(':host { border: var(--card-border); }');
      }
      return Promise.resolve('');
    });

    const issues = await validateCompatibility(
      '/components/overrides/moz-card',
      'moz-card',
      'override',
      baseConfig,
      '/project'
    );

    expect(issues.filter((issue) => issue.check === 'token-prefix-violation')).toHaveLength(0);
  });

  it('still flags non-prefixed variables for custom components', async () => {
    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path === '/components/custom/moz-audit-card/moz-audit-card.css')
    );
    mockReadText.mockResolvedValue(':host { border: var(--card-border); }');

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      baseConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'token-prefix-violation')).toBe(true);
  });

  it('rejects relative imports, missing define calls, and non-MozLitElement classes', async () => {
    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('.mjs') || path.endsWith('.css'))
    );
    mockReadText.mockImplementation((path: string) => {
      if (path.endsWith('.mjs')) {
        return Promise.resolve(`
          import './relative.js';
          class MyComponent extends HTMLElement {}
        `);
      }

      return Promise.resolve(':host { color: var(--mybrowser-accent); }');
    });

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      baseConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'relative-import')).toBe(true);
    expect(issues.some((issue) => issue.check === 'no-custom-element-define')).toBe(true);
    expect(issues.some((issue) => issue.check === 'not-moz-lit-element')).toBe(true);
  });

  it('rejects raw CSS color values', async () => {
    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path === '/components/custom/moz-audit-card/moz-audit-card.css')
    );
    mockReadText.mockResolvedValue(':host { color: #ff0000; }');

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      baseConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'raw-color-value')).toBe(true);
  });

  it('allows token references on the allowlist', async () => {
    const allowlistedConfig: FurnaceConfig = {
      ...baseConfig,
      tokenAllowlist: ['--card-border'],
    };

    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path === '/components/custom/moz-audit-card/moz-audit-card.css')
    );
    mockReadText.mockResolvedValue(':host { border: var(--card-border); }');

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      allowlistedConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'token-prefix-violation')).toBe(false);
  });

  it('allows runtime variables listed in runtimeVariables', async () => {
    const runtimeConfig: FurnaceConfig = {
      ...baseConfig,
      runtimeVariables: ['--cross-component-channel'],
    };

    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path === '/components/custom/moz-audit-card/moz-audit-card.css')
    );
    mockReadText.mockResolvedValue(
      ':host { transform: translateX(var(--cross-component-channel)); }'
    );

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      runtimeConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'token-prefix-violation')).toBe(false);
  });

  it('auto-exempts component-local variables declared and consumed in the same CSS file', async () => {
    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path === '/components/custom/moz-audit-card/moz-audit-card.css')
    );
    // `--cam-x` is both declared and read in this file — runtime state
    // channel, not a design token reference.
    mockReadText.mockResolvedValue(':host { --cam-x: 0; transform: translateX(var(--cam-x)); }');

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      baseConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'token-prefix-violation')).toBe(false);
  });

  it('still flags referenced-but-not-declared unprefixed variables', async () => {
    mockPathExists.mockImplementation((path: string) =>
      Promise.resolve(path === '/components/custom/moz-audit-card/moz-audit-card.css')
    );
    // `--rogue` is read but never declared in this component's CSS — not a
    // local runtime channel, so the token-prefix violation should still fire.
    mockReadText.mockResolvedValue(':host { color: var(--rogue); }');

    const issues = await validateCompatibility(
      '/components/custom/moz-audit-card',
      'moz-audit-card',
      'custom',
      baseConfig,
      '/project'
    );

    expect(issues.some((issue) => issue.check === 'token-prefix-violation')).toBe(true);
  });
});

describe('validateRegistrationPatterns', () => {
  const baseConfig: FurnaceConfig = {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-test': {
        description: 'Test component',
        targetPath: 'toolkit/content/widgets/moz-test',
        register: true,
        localized: false,
      },
    },
  };

  it('reports no issues when .mjs entry is in Pattern B (DOMContentLoaded)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["moz-test", "chrome://global/content/elements/moz-test.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`);

    const issues = await validateRegistrationPatterns('/project', baseConfig);
    expect(issues).toHaveLength(0);
  });

  it('reports error when .mjs entry is in Pattern A (loadSubScript block)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
    ["moz-test", "chrome://global/content/elements/moz-test.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
      ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`);

    const issues = await validateRegistrationPatterns('/project', baseConfig);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe('wrong-registration-pattern');
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toContain('Pattern A');
    expect(issues[0]?.message).toContain('Pattern B');
  });

  it('handles multi-line DOMContentLoaded format without false positives', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    for (let [tag, script] of [
        ["moz-test", "chrome://global/content/elements/moz-test.mjs"],
    ]) {
      customElements.setElementCreationCallback(tag, () => {
        ChromeUtils.importESModule(script);
      });
    }
  }
);
`);

    const issues = await validateRegistrationPatterns('/project', baseConfig);
    expect(issues).toHaveLength(0);
  });

  it('skips components with register=false', async () => {
    mockPathExists.mockResolvedValue(true);

    const configNoRegister: FurnaceConfig = {
      ...baseConfig,
      custom: {
        'moz-test': {
          description: 'Test component',
          targetPath: 'toolkit/content/widgets/moz-test',
          register: false,
          localized: false,
        },
      },
    };

    // Even though tag is in wrong block, register is false so no check
    mockReadText.mockResolvedValue(`
for (let [tag, script] of [
    ["moz-test", "chrome://global/content/elements/moz-test.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {});
`);

    const issues = await validateRegistrationPatterns('/project', configNoRegister);
    expect(issues).toHaveLength(0);
  });
});

describe('validateJarMnEntries', () => {
  const baseConfig: FurnaceConfig = {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-test': {
        description: 'Test component',
        targetPath: 'toolkit/content/widgets/moz-test',
        register: true,
        localized: false,
      },
    },
  };

  it('reports missing .mjs entry in jar.mn', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
   content/global/elements/moz-button.mjs  (widgets/moz-button/moz-button.mjs)
   content/global/elements/moz-button.css  (widgets/moz-button/moz-button.css)
`);

    const issues = await validateJarMnEntries('/project', baseConfig);
    const mjsIssue = issues.find((i) => i.check === 'missing-jar-mn-mjs');
    expect(mjsIssue).toBeDefined();
    expect(mjsIssue?.severity).toBe('error');
  });

  it('reports no issues when entries are present', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
   content/global/elements/moz-test.mjs  (widgets/moz-test/moz-test.mjs)
   content/global/elements/moz-test.css  (widgets/moz-test/moz-test.css)
`);

    const issues = await validateJarMnEntries('/project', baseConfig);
    expect(issues).toHaveLength(0);
  });

  it('skips components with register=false', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue('');

    const configNoRegister: FurnaceConfig = {
      ...baseConfig,
      custom: {
        'moz-test': {
          description: 'Test component',
          targetPath: 'toolkit/content/widgets/moz-test',
          register: false,
          localized: false,
        },
      },
    };

    const issues = await validateJarMnEntries('/project', configNoRegister);
    expect(issues).toHaveLength(0);
  });

  it('handles missing jar.mn file gracefully', async () => {
    mockPathExists.mockResolvedValue(false);

    const issues = await validateJarMnEntries('/project', baseConfig);
    expect(issues).toHaveLength(0);
  });
});

describe('validateTokenLink', () => {
  it('warns when component uses tokens but browser.xhtml lacks link', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('.css')) {
        return Promise.resolve(':host { color: var(--testbrowser-canvas-fg); }');
      }
      if (path.includes('browser.xhtml')) {
        return Promise.resolve('<window><html:body></html:body></window>');
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink(
      '/components/my-comp',
      'my-comp',
      '/project',
      '--testbrowser-'
    );
    const tokenIssues = issues.filter((i) => i.check === 'missing-token-link');
    expect(tokenIssues).toHaveLength(1);
    expect(tokenIssues[0]?.severity).toBe('warning');
    expect(tokenIssues[0]?.message).toContain('testbrowser-tokens.css');
  });

  it('reports no issues when browser.xhtml links the tokens CSS', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('.css')) {
        return Promise.resolve(':host { color: var(--testbrowser-canvas-fg); }');
      }
      if (path.includes('browser.xhtml')) {
        return Promise.resolve(
          '<window><link rel="stylesheet" href="testbrowser-tokens.css" /><html:body></html:body></window>'
        );
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink(
      '/components/my-comp',
      'my-comp',
      '/project',
      '--testbrowser-'
    );
    expect(issues).toHaveLength(0);
  });

  it('reports no issues when component does not use tokens', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('.css')) {
        return Promise.resolve(':host { display: block; }');
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink(
      '/components/my-comp',
      'my-comp',
      '/project',
      '--testbrowser-'
    );
    expect(issues).toHaveLength(0);
  });

  it('reports no issues when no tokenPrefix is configured', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('.css')) {
        return Promise.resolve(':host { color: var(--some-token); }');
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink('/components/my-comp', 'my-comp', '/project');
    expect(issues).toHaveLength(0);
  });

  it('accepts multiple chrome host documents — passes when ANY links the tokens CSS', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('.css')) {
        return Promise.resolve(':host { color: var(--testbrowser-canvas-fg); }');
      }
      // Check the more-specific filename first — `browser.xhtml` is a suffix
      // of `mybrowser.xhtml`, so `endsWith('browser.xhtml')` on the wrong
      // branch would swallow the token link and flip the assertion.
      if (path.endsWith('/mybrowser.xhtml')) {
        return Promise.resolve(
          '<window><link rel="stylesheet" href="testbrowser-tokens.css" /><html:body></html:body></window>'
        );
      }
      if (path.endsWith('/browser.xhtml')) {
        return Promise.resolve('<window><html:body></html:body></window>');
      }
      return Promise.resolve('');
    });

    const issues = await validateTokenLink(
      '/components/my-comp',
      'my-comp',
      '/project',
      '--testbrowser-',
      ['browser/base/content/browser.xhtml', 'browser/base/content/mybrowser.xhtml']
    );
    expect(issues).toHaveLength(0);
  });

  it('warns when none of the configured chrome host documents link the tokens CSS', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockImplementation((path: string) => {
      if (path.includes('.css')) {
        return Promise.resolve(':host { color: var(--testbrowser-canvas-fg); }');
      }
      return Promise.resolve('<window><html:body></html:body></window>');
    });

    const issues = await validateTokenLink(
      '/components/my-comp',
      'my-comp',
      '/project',
      '--testbrowser-',
      ['browser/base/content/browser.xhtml', 'browser/base/content/mybrowser.xhtml']
    );
    const tokenIssues = issues.filter((i) => i.check === 'missing-token-link');
    expect(tokenIssues).toHaveLength(1);
    expect(tokenIssues[0]?.message).toContain('browser.xhtml');
    expect(tokenIssues[0]?.message).toContain('mybrowser.xhtml');
  });
});

describe('validateAccessibility — hardcoded-text', () => {
  it('does not flag text inside elements with data-l10n-id', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<span data-l10n-id="my-string">Fallback Text</span>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(0);
  });

  it('still flags text without data-l10n-id', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class MyComponent extends MozLitElement {
        render() {
          return html\`<span>Some hardcoded text</span>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(1);
  });

  it('does not flag long diagnostic strings passed to console.error', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class Controller {
        handle() {
          console.error("Failed to process tile ID AB-123: camera out of bounds");
          if (this.camX > 0 && this.tileZ < 100) { this.resync(); }
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(0);
  });

  it('does not flag identifier string literals passed to querySelector', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class Controller {
        bind() {
          this.ownerDocument.querySelector("canvas.tile-editor-root");
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(0);
  });

  it('flags text assigned via .textContent', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class Controller {
        render() {
          this.label.textContent = "Save changes";
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(1);
  });

  it('flags text set via setAttribute("label", ...)', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      class Controller {
        build() {
          const item = document.createXULElement("toolbarbutton");
          item.setAttribute("label", "Open preferences");
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(1);
  });

  it('honours file-wide furnace-ignore: hardcoded-text suppression', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReadText.mockResolvedValue(`
      // furnace-ignore: hardcoded-text
      class MyComponent extends MozLitElement {
        render() {
          return html\`<span>Intentional fallback text</span>\`;
        }
      }
    `);

    const issues = await validateAccessibility('/components/my-comp', 'my-comp');
    const textIssues = issues.filter((i) => i.check === 'hardcoded-text');
    expect(textIssues).toHaveLength(0);
  });
});
