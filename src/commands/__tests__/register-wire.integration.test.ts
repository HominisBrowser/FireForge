// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  readText,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { registerCommand } from '../register.js';
import { wireCommand } from '../wire.js';

const logger = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => logger);

describe('registerCommand and wireCommand integration', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/base/jar.mn': [
        'browser.jar:',
        '% content browser %content/browser/',
        '        content/browser/browser-main.js    (content/browser-main.js)',
        '        content/browser/browser-init.js    (content/browser-init.js)',
        '',
      ].join('\n'),
      'browser/base/content/browser-main.js': [
        'function bootstrap() {',
        '  try {',
        '    Services.scriptloader.loadSubScript("chrome://browser/content/browser-main.js", this);',
        '  } catch (e) {',
        '    console.error(e);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'browser/base/content/browser-init.js': [
        'const BrowserGlue = {',
        '  onLoad() {',
        '    this.ready = true;',
        '  },',
        '  onUnload() {',
        '    this.ready = false;',
        '  },',
        '};',
        '',
      ].join('\n'),
      'browser/base/content/browser.xhtml': [
        '<html:body>',
        '#include browser-sets.inc',
        '</html:body>',
        '',
      ].join('\n'),
      'browser/base/content/new-widget.js': 'export const widget = true;\n',
      'browser/base/content/my-widget.js': 'globalThis.MyWidget = { init() {}, destroy() {} };\n',
      'browser/base/content/fragments/my-widget.inc.xhtml': '<box id="my-widget"/>\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('registers browser content files and skips duplicates on repeat', async () => {
    await registerCommand(projectRoot, 'browser/base/content/new-widget.js');
    await registerCommand(projectRoot, 'browser/base/content/new-widget.js');

    const jarMn = await readText(join(projectRoot, 'engine'), 'browser/base/jar.mn');
    expect(jarMn).toContain('content/browser/new-widget.js    (content/new-widget.js)');
    expect(
      jarMn.match(/content\/browser\/new-widget\.js\s+\(content\/new-widget\.js\)/g)
    ).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Already registered: browser/base/content/new-widget.js in browser/base/jar.mn'
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns a dry-run preview for register without mutating manifests', async () => {
    await registerCommand(projectRoot, 'browser/base/content/new-widget.js', { dryRun: true });

    const jarMn = await readText(join(projectRoot, 'engine'), 'browser/base/jar.mn');
    expect(jarMn).not.toContain('new-widget.js');
    expect(logger.info).toHaveBeenCalledWith(
      '[dry-run] Would register browser/base/content/new-widget.js'
    );
    expect(logger.info).toHaveBeenCalledWith('  manifest: browser/base/jar.mn');
    expect(logger.info).toHaveBeenCalledWith(
      '  entry:         content/browser/new-widget.js    (content/new-widget.js)'
    );
    expect(logger.info).toHaveBeenCalledWith(
      '  insert after: content/browser/browser-init.js    (content/browser-init.js)'
    );
  });

  it('wires subscripts, DOM fragments, and jar.mn entries idempotently', async () => {
    const domPath = join(
      projectRoot,
      'engine',
      'browser/base/content/fragments/my-widget.inc.xhtml'
    );

    await wireCommand(projectRoot, 'my-widget', {
      init: 'MyWidget.init()',
      destroy: 'MyWidget.destroy()',
      dom: domPath,
    });
    await wireCommand(projectRoot, 'my-widget', {
      init: 'MyWidget.init()',
      destroy: 'MyWidget.destroy()',
      dom: domPath,
    });

    const browserMain = await readText(
      join(projectRoot, 'engine'),
      'browser/base/content/browser-main.js'
    );
    const browserInit = await readText(
      join(projectRoot, 'engine'),
      'browser/base/content/browser-init.js'
    );
    const browserXhtml = await readText(
      join(projectRoot, 'engine'),
      'browser/base/content/browser.xhtml'
    );
    const jarMn = await readText(join(projectRoot, 'engine'), 'browser/base/jar.mn');

    expect(browserMain.match(/chrome:\/\/browser\/content\/my-widget\.js/g)).toHaveLength(1);
    expect(browserInit.match(/MyWidget\.init\(\);/g)).toHaveLength(1);
    expect(browserInit.match(/MyWidget\.destroy\(\);/g)).toHaveLength(1);
    expect(browserXhtml.match(/#include fragments\/my-widget\.inc\.xhtml/g)).toHaveLength(1);
    expect(
      jarMn.match(/content\/browser\/my-widget\.js\s+\(content\/my-widget\.js\)/g)
    ).toHaveLength(1);
  });

  it('supports wire dry-run without changing files', async () => {
    const domPath = join(
      projectRoot,
      'engine',
      'browser/base/content/fragments/my-widget.inc.xhtml'
    );

    await wireCommand(projectRoot, 'my-widget', {
      init: 'MyWidget.init()',
      dom: domPath,
      dryRun: true,
    });

    const browserMain = await readText(
      join(projectRoot, 'engine'),
      'browser/base/content/browser-main.js'
    );
    expect(browserMain).not.toContain('my-widget.js');
    expect(logger.info).toHaveBeenCalledWith('[dry-run] Would wire subscript:');
  });
});
