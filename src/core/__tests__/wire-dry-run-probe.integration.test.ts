// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-fs integration test for `probeDomFragmentInsertionPoint`.
 *
 * `fireforge wire --dry-run` and the real run must not disagree when `--dom`
 * resolves through `tokenHostDocuments`: dry-run previewing a plausible
 * mutation plan while the real run throws `Could not find insertion point in
 * chrome document` is the failure this closes. The test exercises the probe
 * against a browser.xhtml-shaped file (has an insertion anchor → probe
 * succeeds) and a chrome-doc-shaped file with neither `#include
 * browser-sets.inc` nor `<html:body>` (probe throws the same error the real
 * run would).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { probeDomFragmentInsertionPoint } from '../wire-dom-fragment.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createEngine(): Promise<string> {
  const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-wire-probe-'));
  cleanup.push(engineDir);
  return engineDir;
}

async function createDomFragment(engineDir: string, relPath: string): Promise<void> {
  const fullPath = join(engineDir, relPath);
  await mkdir(join(engineDir, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  await writeFile(fullPath, '<div id="my-fragment"/>\n', 'utf-8');
}

async function createChromeDoc(engineDir: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(engineDir, relPath);
  await mkdir(join(engineDir, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

describe('probeDomFragmentInsertionPoint', () => {
  it('returns without throwing for a chrome doc with a browser-sets.inc anchor', async () => {
    const engineDir = await createEngine();
    const domFilePath = 'browser/base/content/fragments/panel.inc.xhtml';
    const targetPath = 'browser/base/content/browser.xhtml';

    await createDomFragment(engineDir, domFilePath);
    await createChromeDoc(
      engineDir,
      targetPath,
      `<?xml version="1.0"?>
<html:html xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
           xmlns:html="http://www.w3.org/1999/xhtml">
  <html:body>
#include browser-sets.inc
  </html:body>
</html:html>
`
    );

    await expect(
      probeDomFragmentInsertionPoint(engineDir, domFilePath, targetPath)
    ).resolves.toBeUndefined();
  });

  it('returns without throwing for a chrome doc with only an <html:body> anchor', async () => {
    const engineDir = await createEngine();
    const domFilePath = 'browser/base/content/fragments/panel.inc.xhtml';
    const targetPath = 'browser/base/content/ff-workbench.xhtml';

    await createDomFragment(engineDir, domFilePath);
    await createChromeDoc(
      engineDir,
      targetPath,
      `<?xml version="1.0"?>
<html:html xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
           xmlns:html="http://www.w3.org/1999/xhtml">
  <html:body id="workbench">
    <div id="content"/>
  </html:body>
</html:html>
`
    );

    await expect(
      probeDomFragmentInsertionPoint(engineDir, domFilePath, targetPath)
    ).resolves.toBeUndefined();
  });

  it('throws "Could not find insertion point" when no anchor is present', async () => {
    // A `furnace chrome-doc create`-scaffolded top-level chrome document
    // exists and is registered in `tokenHostDocuments[0]`, but lacks both
    // `#include browser-sets.inc` and `<html:body>`. The real run throws
    // inside `addDomFragment`; the probe throws the same error so dry-run
    // catches it too.
    const engineDir = await createEngine();
    const domFilePath = 'browser/base/content/fragments/panel.inc.xhtml';
    const targetPath = 'browser/base/content/ff-workbench.xhtml';

    await createDomFragment(engineDir, domFilePath);
    await createChromeDoc(
      engineDir,
      targetPath,
      `<?xml version="1.0"?>
<root>
  <placeholder/>
</root>
`
    );

    await expect(
      probeDomFragmentInsertionPoint(engineDir, domFilePath, targetPath)
    ).rejects.toThrow(/Could not find insertion point/);
  });

  it('returns without throwing when the directive is already present (idempotent)', async () => {
    const engineDir = await createEngine();
    const domFilePath = 'browser/base/content/fragments/panel.inc.xhtml';
    const targetPath = 'browser/base/content/browser.xhtml';

    await createDomFragment(engineDir, domFilePath);
    // The `#include` resolves relative to the chrome doc's directory,
    // so `panel.inc.xhtml` living under the same parent means the
    // include path is `fragments/panel.inc.xhtml`.
    await createChromeDoc(
      engineDir,
      targetPath,
      `<?xml version="1.0"?>
<html:html>
#include fragments/panel.inc.xhtml
<html:body/>
</html:html>
`
    );

    await expect(
      probeDomFragmentInsertionPoint(engineDir, domFilePath, targetPath)
    ).resolves.toBeUndefined();
  });

  it('throws when the chrome doc does not exist on disk', async () => {
    const engineDir = await createEngine();
    const domFilePath = 'browser/base/content/fragments/panel.inc.xhtml';
    await createDomFragment(engineDir, domFilePath);

    await expect(
      probeDomFragmentInsertionPoint(
        engineDir,
        domFilePath,
        'browser/base/content/does-not-exist.xhtml'
      )
    ).rejects.toThrow(/not found in engine/);
  });
});
