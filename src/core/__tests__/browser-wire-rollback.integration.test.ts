// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { wireSubscript } from '../browser-wire.js';

/**
 * Integration-style tests for the wire rollback journal.
 *
 * The existing unit tests in `browser-wire.test.ts` mock `utils/fs.js`
 * heavily so every wire-target helper can be exercised in isolation. That
 * approach is a poor fit for the rollback path because rollback
 * deliberately bypasses the wrapper module and calls `node:fs/promises`
 * directly. These tests build a real filesystem fixture under `tmpdir()`
 * with plausible stand-ins for `browser-main.js`, `browser-init.js`, the
 * chrome document, and `browser/base/jar.mn`, invoke `wireSubscript`, and
 * verify that a forced failure mid-sequence leaves every file byte-for-byte
 * identical to its pre-wire state.
 *
 * The failure is injected at the DOM-fragment insertion step — the actual
 * repro from the eval findings — by passing a chrome-document path whose
 * contents do not contain an insertion anchor (no `#include
 * browser-sets.inc` and no `<html:body>`). That matches what an operator
 * sees when pointing `wire --dom` at a fork that has already replaced the
 * upstream browser.xhtml with something else without preserving one of
 * those anchors.
 */

// Silence intro/outro + warn() during tests. The wire helpers call
// `utils/logger.js`'s warn() on AST fallback; we don't need that output.
vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
}));

// The wire flow calls getProjectPaths to derive engineDir; the real module
// assumes a configured FireForge project, so substitute a minimal one.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    getProjectPaths: (root: string) => ({
      root,
      engine: join(root, 'engine'),
      config: join(root, 'fireforge.json'),
      fireforgeDir: join(root, '.fireforge'),
      state: join(root, '.fireforge', 'state.json'),
      patches: join(root, 'patches'),
      configs: join(root, 'configs'),
      src: join(root, 'src'),
      componentsDir: join(root, 'components'),
    }),
  };
});

interface Fixture {
  projectRoot: string;
  engineDir: string;
  paths: {
    browserMain: string;
    browserInit: string;
    chromeDoc: string;
    jarMn: string;
  };
  /** Snapshots of the files before wire ran — compared against post-wire state. */
  pristine: {
    browserMain: string;
    browserInit: string;
    chromeDoc: string;
    jarMn: string;
  };
}

/**
 * Writes a minimal-but-parseable engine scaffold. browser-main.js carries
 * one existing `loadSubScript` so the AST pathway has a pattern to anchor
 * against. browser-init.js has both onLoad and onUnload so init/destroy
 * expressions could theoretically be added. The chrome document is
 * intentionally missing BOTH anchor patterns so `addDomFragment` fails,
 * which triggers the rollback path we want to observe.
 */
async function buildFixture(chromeDocContents: string): Promise<Fixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'fireforge-wire-rollback-'));
  const engineDir = join(projectRoot, 'engine');
  const paths = {
    browserMain: join(engineDir, 'browser/base/content/browser-main.js'),
    browserInit: join(engineDir, 'browser/base/content/browser-init.js'),
    chromeDoc: join(engineDir, 'browser/base/content/browser.xhtml'),
    jarMn: join(engineDir, 'browser/base/jar.mn'),
  };

  await mkdir(join(engineDir, 'browser/base/content'), { recursive: true });
  await mkdir(join(engineDir, 'browser/components/mybrowser'), { recursive: true });

  const browserMain = `{
  try {
    Services.scriptloader.loadSubScript("chrome://browser/content/browser-places.js", this);
  } catch (e) {
    console.error("Failed to load browser-places.js:", e);
  }
}
`;
  const browserInit = `var gBrowserInit = {
  onLoad() {
    gBrowser.init();
  },
  onUnload() {
    gBrowser.destroy();
  },
};
`;
  const jarMn = `[localization] @AB_CD@.jar:
  content/browser/existing-file.js (content/existing-file.js)
`;

  await writeFile(paths.browserMain, browserMain, 'utf8');
  await writeFile(paths.browserInit, browserInit, 'utf8');
  await writeFile(paths.chromeDoc, chromeDocContents, 'utf8');
  await writeFile(paths.jarMn, jarMn, 'utf8');

  // Also write the `.inc.xhtml` fragment the wire would try to insert so the
  // wire code doesn't short-circuit on a missing source file before hitting
  // the chrome-doc insertion step.
  await writeFile(
    join(engineDir, 'browser/components/mybrowser/mybrowser-chrome.inc.xhtml'),
    '<html:div id="mybrowser-root">real content</html:div>\n',
    'utf8'
  );

  return {
    projectRoot,
    engineDir,
    paths,
    pristine: {
      browserMain,
      browserInit,
      chromeDoc: chromeDocContents,
      jarMn,
    },
  };
}

async function readSnapshot(fixture: Fixture): Promise<Fixture['pristine']> {
  const [browserMain, browserInit, chromeDoc, jarMn] = await Promise.all([
    readFile(fixture.paths.browserMain, 'utf8'),
    readFile(fixture.paths.browserInit, 'utf8'),
    readFile(fixture.paths.chromeDoc, 'utf8'),
    readFile(fixture.paths.jarMn, 'utf8'),
  ]);
  return { browserMain, browserInit, chromeDoc, jarMn };
}

describe('wireSubscript — transactional rollback', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 }))
    );
  });

  it('restores every touched file when the DOM fragment step fails', async () => {
    // Chrome document without either anchor — the tokenizer AND the legacy
    // regex fallback both fail, which is the eval-repro condition. Note
    // that the legacy fallback substring-matches `<html:body`, so the
    // fixture cannot even mention that token in a comment.
    const badChromeDoc = `<?xml version="1.0"?>
<window>
  <hbox/>
</window>
`;
    const fixture = await buildFixture(badChromeDoc);
    cleanup.push(fixture.projectRoot);

    await expect(
      wireSubscript(fixture.projectRoot, 'mybrowser', {
        init: 'MyBrowser.init()',
        destroy: 'MyBrowser.destroy()',
        domFilePath: 'browser/components/mybrowser/mybrowser-chrome.inc.xhtml',
      })
    ).rejects.toThrow(/Could not find insertion point/);

    // Every file we snapshotted must be byte-for-byte identical to its
    // pristine contents. Any delta means the rollback is missing a target
    // or the rollback restore itself did not run.
    const after = await readSnapshot(fixture);
    expect(after.browserMain).toBe(fixture.pristine.browserMain);
    expect(after.browserInit).toBe(fixture.pristine.browserInit);
    expect(after.chromeDoc).toBe(fixture.pristine.chromeDoc);
    expect(after.jarMn).toBe(fixture.pristine.jarMn);
  });

  it('leaves mutations in place on a successful wire', async () => {
    // Chrome document with the `#include browser-sets.inc` anchor so the
    // DOM-fragment step succeeds; the full wire then completes and we
    // expect every file to have been extended with the new subscript,
    // init/destroy expressions, include directive, and jar.mn entry.
    const goodChromeDoc = `<?xml version="1.0"?>
<window>
  <html:body>
#include browser-sets.inc
  </html:body>
</window>
`;
    const fixture = await buildFixture(goodChromeDoc);
    cleanup.push(fixture.projectRoot);

    const result = await wireSubscript(fixture.projectRoot, 'mybrowser', {
      init: 'MyBrowser.init()',
      destroy: 'MyBrowser.destroy()',
      domFilePath: 'browser/components/mybrowser/mybrowser-chrome.inc.xhtml',
    });

    expect(result.subscriptAdded).toBe(true);
    expect(result.initAdded).toBe(true);
    expect(result.destroyAdded).toBe(true);
    expect(result.domInserted).toBe(true);
    expect(result.jarMnResult.skipped).toBe(false);

    const after = await readSnapshot(fixture);
    expect(after.browserMain).toContain('mybrowser.js');
    expect(after.browserInit).toContain('MyBrowser.init()');
    expect(after.browserInit).toContain('MyBrowser.destroy()');
    expect(after.chromeDoc).toContain('mybrowser-chrome.inc.xhtml');
    expect(after.jarMn).toContain('content/browser/mybrowser.js');
  });
});
