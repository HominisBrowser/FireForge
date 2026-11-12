// SPDX-License-Identifier: EUPL-1.2
/** `register` and `wire` through the CLI against a synthetic engine on disk. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../testing/cli.js';
import { writeSyntheticFirefox } from '../testing/firefox.js';
import { readTree, useTempDir, writeTree } from '../testing/temp.js';

const dir = useTempDir();

const CONFIG = {
  name: 'Acme',
  vendor: 'Example Vendor',
  appId: 'org.example.acme',
  binaryName: 'acme',
  firefox: {
    version: '153.7.0esr',
    product: 'firefox-esr',
    sha256: '7f8715ee7de2cf36a156216a9b1c7f26d1653010e65793bb2fce66e12edb6ea0',
    candidate: 'build1',
  },
};

const BROWSER_MAIN =
  'var main = {\n  load() {\n    try {\n      Services.scriptloader.loadSubScript("chrome://browser/content/browser.js", this);\n    } catch (e) {\n      console.error(e);\n    }\n  },\n};\n';
const BROWSER_INIT =
  'var gBrowserInit = {\n  onLoad() {\n    start();\n  },\n  onUnload() {\n    stop();\n  },\n};\n';

async function engineFile(path: string): Promise<string> {
  return readFile(join(dir(), 'engine', path), 'utf8');
}

beforeEach(async () => {
  await writeTree(dir(), { 'fireforge.json': `${JSON.stringify(CONFIG, null, 2)}\n` });
  await writeSyntheticFirefox(join(dir(), 'engine'), {
    'browser/base/content/browser-main.js': BROWSER_MAIN,
    'browser/base/content/browser-init.js': BROWSER_INIT,
    'browser/base/content/panel.js': '// panel\n',
    'browser/base/content/feature.js': '// feature\n',
    'browser/base/content/browser.xhtml': '<window>\n#include browser-sets.inc\n</window>\n',
    'browser/base/content/frag.inc.xhtml': '<box id="frag"/>\n',
  });
});

describe('fireforge register', () => {
  it('registers a file, accepting an engine/-prefixed path', async () => {
    const result = await runCli(['register', 'engine/browser/base/content/panel.js'], {
      cwd: dir(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Registered browser/base/content/panel.js in browser/base/jar.mn'
    );
    expect(await engineFile('browser/base/jar.mn')).toContain(
      'content/browser/panel.js                (content/panel.js)'
    );
  });

  it('is idempotent and reports it', async () => {
    await runCli(['register', 'browser/base/content/panel.js'], { cwd: dir() });
    const again = await runCli(['register', 'browser/base/content/panel.js', '--json'], {
      cwd: dir(),
    });
    expect(JSON.parse(again.stdout)).toMatchObject({ changed: false, dryRun: false });
  });

  it('writes nothing under --dry-run, even for a file that does not exist yet', async () => {
    const before = await readTree(join(dir(), 'engine'));
    const result = await runCli(
      ['register', 'browser/base/content/future.js', '--dry-run', '--json'],
      { cwd: dir() }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      manifest: 'browser/base/jar.mn',
      changed: true,
      dryRun: true,
    });
    expect(await readTree(join(dir(), 'engine'))).toEqual(before);
  });

  it('refuses a file that does not exist', async () => {
    const result = await runCli(['register', 'browser/base/content/future.js'], { cwd: dir() });
    expect(result.exitCode).toBe(8);
    expect(result.stderr).toContain('File not found: browser/base/content/future.js');
  });

  it('refuses a path outside the engine', async () => {
    const result = await runCli(['register', '../outside.js'], { cwd: dir() });
    expect(result.exitCode).toBe(8);
    expect(result.stderr).toContain('outside the engine');
  });

  it('creates a module manifest with --create-manifest', async () => {
    await writeTree(join(dir(), 'engine'), { 'browser/modules/acme/Thing.sys.mjs': '' });
    const missing = await runCli(['register', 'browser/modules/acme/Thing.sys.mjs'], {
      cwd: dir(),
    });
    expect(missing.exitCode).toBe(1);
    const created = await runCli(
      ['register', 'browser/modules/acme/Thing.sys.mjs', '--create-manifest'],
      { cwd: dir() }
    );
    expect(created.exitCode).toBe(0);
    expect(await engineFile('browser/modules/acme/moz.build')).toContain(
      'EXTRA_JS_MODULES.acme += [\n    "Thing.sys.mjs",\n]'
    );
    expect(await engineFile('browser/modules/moz.build')).toContain('"acme"');
  });
});

describe('fireforge wire', () => {
  it('wires everything it was asked to', async () => {
    const result = await runCli(
      [
        'wire',
        'feature',
        '--init',
        'Feature.init',
        '--destroy',
        'Feature.destroy',
        '--dom',
        'browser/base/content/frag.inc.xhtml',
      ],
      { cwd: dir() }
    );
    expect(result.exitCode).toBe(0);
    expect(await engineFile('browser/base/content/browser-main.js')).toContain(
      '// ACME: wire-subscript feature'
    );
    expect(await engineFile('browser/base/content/browser-init.js')).toContain(
      'Feature.destroy();'
    );
    expect(await engineFile('browser/base/content/browser.xhtml')).toContain(
      '#include frag.inc.xhtml\n#include browser-sets.inc'
    );
    expect(await engineFile('browser/base/jar.mn')).toContain('content/browser/feature.js');
  });

  it('changes no file when one step cannot be done', async () => {
    await writeTree(join(dir(), 'engine'), { 'browser/base/content/browser.xhtml': '<window/>\n' });
    const before = await readTree(join(dir(), 'engine'));
    const result = await runCli(
      ['wire', 'feature', '--dom', 'browser/base/content/frag.inc.xhtml', '--init', 'Feature.init'],
      { cwd: dir() }
    );
    expect(result.exitCode).toBe(1);
    expect(await readTree(join(dir(), 'engine'))).toEqual(before);
  });

  it('previews a plan for a script that does not exist yet and refuses it for real', async () => {
    const preview = await runCli(['wire', 'ghost', '--dry-run'], { cwd: dir() });
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Would change browser/base/content/browser-main.js');
    const real = await runCli(['wire', 'ghost'], { cwd: dir() });
    expect(real.exitCode).toBe(8);
    expect(real.stderr).toContain('Subscript file not found');
  });

  it('rejects an unsafe name', async () => {
    const result = await runCli(['wire', '../evil'], { cwd: dir() });
    expect(result.exitCode).toBe(8);
  });

  it('honours wire.subscriptDir and wire.domTarget', async () => {
    await writeTree(dir(), {
      'fireforge.json': `${JSON.stringify(
        {
          ...CONFIG,
          wire: { subscriptDir: 'browser/base/extra', domTarget: 'browser/base/content/win.xhtml' },
        },
        null,
        2
      )}\n`,
    });
    await writeTree(join(dir(), 'engine'), {
      'browser/base/extra/feature.js': '',
      'browser/base/content/win.xhtml': '<html:body>\n',
    });
    const result = await runCli(
      ['wire', 'feature', '--dom', 'browser/base/content/frag.inc.xhtml'],
      { cwd: dir() }
    );
    expect(result.exitCode).toBe(0);
    expect(await engineFile('browser/base/jar.mn')).toContain('(extra/feature.js)');
    expect(await engineFile('browser/base/content/win.xhtml')).toContain('#include frag.inc.xhtml');
  });
});
