// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace rename` rewrites the customElements.js entry in place: the entry
 * keeps its position, layout and `// <MARKER>:` comments, and the old tag
 * is gone afterwards.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CUSTOM_ELEMENTS_JS } from '../furnace-constants.js';
import { renameCustomElementRegistration } from '../furnace-registration-rename.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeEngine(content?: string): Promise<{ engineDir: string; path: string }> {
  const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-rename-reg-'));
  cleanupPaths.push(engineDir);
  const path = join(engineDir, CUSTOM_ELEMENTS_JS);
  if (content !== undefined) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { engineDir, path };
}

const MULTI_LINE = `document.addEventListener("DOMContentLoaded", () => {
  for (let [tag, script] of [
    [  // HOMINIS:
      "moz-hominis-command-palette",  // HOMINIS:
      "chrome://global/content/elements/moz-hominis-command-palette.mjs",  // HOMINIS:
    ],  // HOMINIS:
    ["moz-hominis-dock", "chrome://global/content/elements/moz-hominis-dock.mjs"],  // HOMINIS:
  ]) {
    customElements.setElementCreationCallback(tag, () => ChromeUtils.importESModule(script));
  }
});
`;

describe('renameCustomElementRegistration', () => {
  it('rewrites a multi-line entry in place, keeping every marker comment', async () => {
    const { engineDir, path } = await makeEngine(MULTI_LINE);

    await expect(
      renameCustomElementRegistration(
        engineDir,
        'moz-hominis-command-palette',
        'moz-hominis-command-panel'
      )
    ).resolves.toBe(true);

    const after = await readFile(path, 'utf8');
    expect(after).not.toContain('moz-hominis-command-palette');
    expect(after).toBe(
      MULTI_LINE.replaceAll('moz-hominis-command-palette', 'moz-hominis-command-panel')
    );
  });

  it('rewrites a single-line entry and leaves a longer sibling tag alone', async () => {
    const before = `for (let [tag, script] of [
  ["moz-card", "chrome://global/content/elements/moz-card.mjs"],  // MYBROWSER:
  ["moz-card-group", "chrome://global/content/elements/moz-card-group.mjs"],
]) {}
`;
    const { engineDir, path } = await makeEngine(before);

    await renameCustomElementRegistration(engineDir, 'moz-card', 'moz-tile');

    const after = await readFile(path, 'utf8');
    expect(after).toContain(
      '["moz-tile", "chrome://global/content/elements/moz-tile.mjs"],  // MYBROWSER:'
    );
    expect(after).toContain(
      '["moz-card-group", "chrome://global/content/elements/moz-card-group.mjs"],'
    );
  });

  it('rewrites an entry of a registration list declared by name', async () => {
    const before = `const ELEMENTS = [
  ["moz-alpha", "chrome://global/content/elements/moz-alpha.mjs"],  // MYBROWSER:
];
for (let [tag, script] of ELEMENTS) {}
`;
    const { engineDir, path } = await makeEngine(before);

    await renameCustomElementRegistration(engineDir, 'moz-alpha', 'moz-omega');

    expect(await readFile(path, 'utf8')).toBe(before.replaceAll('moz-alpha', 'moz-omega'));
  });

  it('rewrites a standalone setElementCreationCallback statement', async () => {
    const before = `customElements.setElementCreationCallback("moz-banner", () => {
  Services.scriptloader.loadSubScript("chrome://global/content/elements/moz-banner.js", window);
}); // MYBROWSER:
`;
    const { engineDir, path } = await makeEngine(before);

    await renameCustomElementRegistration(engineDir, 'moz-banner', 'moz-ribbon');

    expect(await readFile(path, 'utf8')).toBe(before.replaceAll('moz-banner', 'moz-ribbon'));
  });

  it('declines, writing nothing, when there is nothing to rewrite safely', async () => {
    const missing = await makeEngine();
    await expect(
      renameCustomElementRegistration(missing.engineDir, 'moz-a', 'moz-b')
    ).resolves.toBe(false);

    const notRegistered = await makeEngine(`for (let [tag, script] of [["moz-x", "u"]]) {}\n`);
    await expect(
      renameCustomElementRegistration(notRegistered.engineDir, 'moz-a', 'moz-b')
    ).resolves.toBe(false);

    // The new tag is already registered: an in-place rewrite would register it twice.
    const both = `for (let [tag, script] of [\n  ["moz-a", "u"],\n  ["moz-b", "v"],\n]) {}\n`;
    const duplicate = await makeEngine(both);
    await expect(
      renameCustomElementRegistration(duplicate.engineDir, 'moz-a', 'moz-b')
    ).resolves.toBe(false);
    expect(await readFile(duplicate.path, 'utf8')).toBe(both);

    // Unparsable: never edited around.
    const broken = `for (let [tag, script] of [["moz-a", "u"] {\n`;
    const unparsable = await makeEngine(broken);
    await expect(
      renameCustomElementRegistration(unparsable.engineDir, 'moz-a', 'moz-b')
    ).resolves.toBe(false);
    expect(await readFile(unparsable.path, 'utf8')).toBe(broken);

    // The literal appears, but not as a registration.
    const unrelated = `const note = "moz-a";\nfor (let [tag, script] of [["moz-x", "u"]]) {}\n`;
    const literalOnly = await makeEngine(unrelated);
    await expect(
      renameCustomElementRegistration(literalOnly.engineDir, 'moz-a', 'moz-b')
    ).resolves.toBe(false);
    expect(await readFile(literalOnly.path, 'utf8')).toBe(unrelated);
  });
});
