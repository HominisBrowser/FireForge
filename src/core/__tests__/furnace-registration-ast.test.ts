// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FurnaceError } from '../../errors/furnace.js';
import { CUSTOM_ELEMENTS_JS } from '../furnace-constants.js';
import {
  addCustomElementRegistration,
  validateCustomElementRegistration,
} from '../furnace-registration-ast.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'customElements');

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeEngineWithFixture(fixtureName: string): Promise<{
  engineDir: string;
  customElementsPath: string;
}> {
  const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ast-test-'));
  cleanupPaths.push(engineDir);

  // CUSTOM_ELEMENTS_JS is a relative path under the engine root, mirroring
  // the real Firefox layout.
  const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
  await mkdir(dirname(customElementsPath), { recursive: true });

  const fixtureContent = await readFile(join(fixturesDir, fixtureName), 'utf8');
  await writeFile(customElementsPath, fixtureContent);

  return { engineDir, customElementsPath };
}

describe('addCustomElementRegistration — basic fixture', () => {
  let engineDir: string;
  let customElementsPath: string;

  beforeEach(async () => {
    ({ engineDir, customElementsPath } = await makeEngineWithFixture('basic.js'));
  });

  it('adds an .mjs registration into the DOMContentLoaded block', async () => {
    await addCustomElementRegistration(
      engineDir,
      'moz-banner',
      'chrome://global/content/elements/moz-banner.mjs'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    // The new entry must appear inside the DOMContentLoaded block, not the
    // legacy loadSubScript block. The DCL block in the fixture sits after
    // the legacy block, so finding the moz-banner entry after the
    // addEventListener call is sufficient.
    const dclIndex = updated.indexOf('addEventListener');
    const bannerIndex = updated.indexOf('"moz-banner"');
    expect(dclIndex).toBeGreaterThan(-1);
    expect(bannerIndex).toBeGreaterThan(dclIndex);
  });

  it('inserts in alphabetical order relative to existing entries', async () => {
    await addCustomElementRegistration(
      engineDir,
      'moz-banner',
      'chrome://global/content/elements/moz-banner.mjs'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    const bannerIdx = updated.indexOf('moz-banner');
    const buttonIdx = updated.indexOf('moz-button');
    const cardIdx = updated.indexOf('moz-card');

    expect(bannerIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(-1);
    expect(cardIdx).toBeGreaterThan(-1);
    // Alphabetical: banner < button < card
    expect(bannerIdx).toBeLessThan(buttonIdx);
    expect(buttonIdx).toBeLessThan(cardIdx);
  });

  it('adds a .js registration into the legacy loadSubScript block', async () => {
    await addCustomElementRegistration(
      engineDir,
      'browser-toolbar',
      'chrome://global/content/elements/browser-toolbar.js'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    // The legacy block sits before the addEventListener call. The new entry
    // must appear before it.
    const dclIndex = updated.indexOf('addEventListener');
    const newIndex = updated.indexOf('"browser-toolbar"');
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeLessThan(dclIndex);
  });

  it('is idempotent: re-running for an already-registered tag is a no-op', async () => {
    const before = await readFile(customElementsPath, 'utf8');

    await addCustomElementRegistration(
      engineDir,
      'moz-button',
      'chrome://global/content/elements/moz-button.mjs'
    );

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).toBe(before);
  });

  it('throws FurnaceError when the tag name is invalid', async () => {
    await expect(
      addCustomElementRegistration(
        engineDir,
        'NotValidTag',
        'chrome://global/content/elements/whatever.mjs'
      )
    ).rejects.toThrow(FurnaceError);
  });

  it('throws FurnaceError when customElements.js is missing', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'fireforge-ast-empty-'));
    cleanupPaths.push(emptyDir);

    await expect(
      addCustomElementRegistration(
        emptyDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).rejects.toThrow(/customElements\.js not found/);
  });
});

describe('addCustomElementRegistration — multiline DCL fixture', () => {
  it('handles addEventListener with arguments split across lines', async () => {
    const { engineDir, customElementsPath } = await makeEngineWithFixture('multiline-dcl.js');

    await addCustomElementRegistration(
      engineDir,
      'moz-banner',
      'chrome://global/content/elements/moz-banner.mjs'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    const dclIndex = updated.indexOf('addEventListener');
    const bannerIndex = updated.indexOf('"moz-banner"');
    expect(bannerIndex).toBeGreaterThan(dclIndex);
  });
});

describe('addCustomElementRegistration — multiline array fixture', () => {
  it('preserves multiline entry formatting when inserting alphabetically', async () => {
    const { engineDir, customElementsPath } = await makeEngineWithFixture('multiline-array.js');

    await addCustomElementRegistration(
      engineDir,
      'moz-banner',
      'chrome://global/content/elements/moz-banner.mjs'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    // The new entry should be multi-line because the surrounding entries
    // are multi-line. We assert the tag and url appear on adjacent lines
    // rather than collapsed onto one.
    const bannerLine = updated.indexOf('"moz-banner"');
    const bannerUrl = updated.indexOf('"chrome://global/content/elements/moz-banner.mjs"');
    expect(bannerLine).toBeGreaterThan(-1);
    expect(bannerUrl).toBeGreaterThan(bannerLine);
    // Specifically: there should be a newline between the tag and the url.
    const between = updated.slice(bannerLine, bannerUrl);
    expect(between).toContain('\n');
  });
});

describe('addCustomElementRegistration — H4 syntactic pre-flight', () => {
  it('rejects a customElements.js with no for...of loop', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ast-corrupt-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    // Valid JavaScript, but missing the registration loop.
    await writeFile(customElementsPath, `// just a comment\nconst x = 1;\n`);

    await expect(
      addCustomElementRegistration(
        engineDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).rejects.toThrow(/recognizable registration loop/);
  });

  it('rejects an ESM tag when no DOMContentLoaded block exists', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ast-no-dcl-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    // Has a for...of loop (passes the first guard) but no DCL block.
    await writeFile(
      customElementsPath,
      `for (let [tag, script] of [["findbar", "chrome://global/content/elements/findbar.js"]]) {}\n`
    );

    await expect(
      addCustomElementRegistration(
        engineDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).rejects.toThrow(/no DOMContentLoaded block/);
  });

  it('allows a legacy .js tag even without a DOMContentLoaded block', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ast-legacy-only-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    await writeFile(
      customElementsPath,
      `for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}
`
    );

    // Legacy module path, no DCL block — pre-flight should not block, and
    // the AST walker should successfully insert into the only available
    // for-of loop.
    await addCustomElementRegistration(
      engineDir,
      'browser-toolbar',
      'chrome://global/content/elements/browser-toolbar.js'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    expect(updated).toContain('"browser-toolbar"');
  });

  it('accepts const destructuring loops in the pre-flight check', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-ast-const-loop-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    await writeFile(
      customElementsPath,
      `for (const [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {
  customElements.setElementCreationCallback(tag, () => {
    Services.scriptloader.loadSubScript(script, window);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  for (const [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
  ]) {
    customElements.setElementCreationCallback(tag, () => {
      ChromeUtils.importESModule(script);
    });
  }
});
`
    );

    await addCustomElementRegistration(
      engineDir,
      'moz-banner',
      'chrome://global/content/elements/moz-banner.mjs'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    expect(updated).toContain('"moz-banner"');
  });
});

describe('validateCustomElementRegistration', () => {
  it('throws FurnaceError when customElements.js does not exist', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-validate-missing-'));
    cleanupPaths.push(engineDir);

    await expect(
      validateCustomElementRegistration(
        engineDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).rejects.toThrow(/customElements\.js not found/);
  });

  it('returns without throwing when the tag is already registered', async () => {
    const { engineDir } = await makeEngineWithFixture('basic.js');

    // moz-button is already in the basic fixture
    await expect(
      validateCustomElementRegistration(
        engineDir,
        'moz-button',
        'chrome://global/content/elements/moz-button.mjs'
      )
    ).resolves.toBeUndefined();
  });

  it('throws when customElements.js has no for...of loop', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-validate-no-loop-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    await writeFile(customElementsPath, `// no loop here\nconst x = 1;\n`);

    await expect(
      validateCustomElementRegistration(
        engineDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).rejects.toThrow(/recognizable registration loop/);
  });

  it('throws for an ESM tag when no DOMContentLoaded block exists', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-validate-no-dcl-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    await writeFile(
      customElementsPath,
      `for (let [tag, script] of [["findbar", "chrome://global/content/elements/findbar.js"]]) {}\n`
    );

    await expect(
      validateCustomElementRegistration(
        engineDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).rejects.toThrow(/no DOMContentLoaded block/);
  });

  it('does not throw when AST fails but regex fallback succeeds', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-validate-regex-fb-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    // The @ symbol causes the AST parser to throw a SyntaxError (non-FurnaceError),
    // but the file still has regex-matchable entries and a for...of + DCL shape
    // that passes pre-flight.
    await writeFile(
      customElementsPath,
      `@ invalid syntax but passes preflight checks
for (let [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
]) {}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
    ["moz-card", "chrome://global/content/elements/moz-card.mjs"],
  ]) {}
});
`
    );

    await expect(
      validateCustomElementRegistration(
        engineDir,
        'moz-banner',
        'chrome://global/content/elements/moz-banner.mjs'
      )
    ).resolves.toBeUndefined();
  });
});

describe('addCustomElementRegistration — regex fallback insert before first entry', () => {
  it('inserts before all existing entries when the tag sorts first alphabetically', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-regex-before-first-'));
    cleanupPaths.push(engineDir);
    const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
    await mkdir(dirname(customElementsPath), { recursive: true });
    // The @ symbol on the first line causes the AST parser to throw a
    // SyntaxError, forcing the regex fallback path. The rest of the file has
    // valid registration entries that the regex can match. The tag "aaa-widget"
    // sorts before all existing tags ("moz-button", "moz-card").
    await writeFile(
      customElementsPath,
      `@ invalid syntax forces regex fallback
for (let [tag, script] of [
    ["findbar", "chrome://global/content/elements/findbar.js"],
]) {}

document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
    ["moz-card", "chrome://global/content/elements/moz-card.mjs"],
  ]) {}
});
`
    );

    await addCustomElementRegistration(
      engineDir,
      'aaa-widget',
      'chrome://global/content/elements/aaa-widget.mjs'
    );

    const updated = await readFile(customElementsPath, 'utf8');
    const aaaIdx = updated.indexOf('"aaa-widget"');
    const buttonIdx = updated.indexOf('"moz-button"');
    const cardIdx = updated.indexOf('"moz-card"');

    expect(aaaIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(-1);
    expect(cardIdx).toBeGreaterThan(-1);
    // aaa-widget must appear before moz-button (inserted before first entry)
    expect(aaaIdx).toBeLessThan(buttonIdx);
    expect(buttonIdx).toBeLessThan(cardIdx);
  });
});
