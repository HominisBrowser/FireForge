// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CUSTOM_ELEMENTS_JS } from '../furnace-constants.js';
import { removeCustomElementRegistration } from '../furnace-registration-remove.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeEngineWithContent(content: string): Promise<{
  engineDir: string;
  customElementsPath: string;
}> {
  const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-remove-test-'));
  cleanupPaths.push(engineDir);
  const customElementsPath = join(engineDir, CUSTOM_ELEMENTS_JS);
  await mkdir(dirname(customElementsPath), { recursive: true });
  await writeFile(customElementsPath, content);
  return { engineDir, customElementsPath };
}

describe('removeCustomElementRegistration — strategy 1: standalone callback', () => {
  it('removes the entire setElementCreationCallback block', async () => {
    const before = `customElements.setElementCreationCallback("moz-banner", () => {
  Services.scriptloader.loadSubScript(
    "chrome://global/content/elements/moz-banner.js",
    window
  );
});

// other content
const x = 1;
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).not.toContain('moz-banner');
    expect(after).toContain('const x = 1;');
  });

  it('removes a leading blank line along with the callback block', async () => {
    const before = `// header

customElements.setElementCreationCallback("moz-banner", () => {
  doStuff();
});

const next = 1;
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    // The blank line that preceded the block should also be gone: the
    // header line should be immediately followed by the const declaration
    // (with at most a single blank between them, not two).
    expect(after).not.toContain('moz-banner');
    expect(after).toMatch(/header\n\nconst next = 1;/);
  });
});

describe('removeCustomElementRegistration — strategy 2: single-line array entry', () => {
  it('removes the matching single-line entry', async () => {
    const before = `for (let [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
    ["moz-banner", "chrome://global/content/elements/moz-banner.mjs"],
    ["moz-card", "chrome://global/content/elements/moz-card.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {});
}
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).not.toContain('moz-banner');
    // Sibling entries should still be there.
    expect(after).toContain('moz-button');
    expect(after).toContain('moz-card');
  });
});

describe('removeCustomElementRegistration — strategy 3: multi-line array entry', () => {
  it('removes the entire multi-line entry block (open bracket through close)', async () => {
    const before = `for (let [tag, script] of [
    [
      "moz-button",
      "chrome://global/content/elements/moz-button.mjs",
    ],
    [
      "moz-banner",
      "chrome://global/content/elements/moz-banner.mjs",
    ],
    [
      "moz-card",
      "chrome://global/content/elements/moz-card.mjs",
    ],
]) {
  customElements.setElementCreationCallback(tag, () => {});
}
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).not.toContain('moz-banner');
    expect(after).toContain('moz-button');
    expect(after).toContain('moz-card');
    // Sanity check: the surviving entries should still contain their url
    // strings, i.e. removal didn't accidentally chop into a sibling.
    expect(after).toContain('"chrome://global/content/elements/moz-button.mjs"');
    expect(after).toContain('"chrome://global/content/elements/moz-card.mjs"');
  });
});

describe('removeCustomElementRegistration — idempotence', () => {
  it('is a no-op when the tag is not registered', async () => {
    const before = `for (let [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {});
}
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-nonexistent');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).toBe(before);
  });

  it('is a no-op when customElements.js does not exist', async () => {
    const engineDir = await mkdtemp(join(tmpdir(), 'fireforge-remove-empty-'));
    cleanupPaths.push(engineDir);

    // Should not throw.
    await expect(removeCustomElementRegistration(engineDir, 'moz-button')).resolves.toBeUndefined();
  });
});

describe('removeCustomElementRegistration — reformatted files (AST robustness)', () => {
  it('handles tab-indented multi-line entries', async () => {
    const before = `for (let [tag, script] of [
\t[\n\t\t"moz-button",\n\t\t"chrome://global/content/elements/moz-button.mjs",\n\t],
\t[\n\t\t"moz-banner",\n\t\t"chrome://global/content/elements/moz-banner.mjs",\n\t],
\t[\n\t\t"moz-card",\n\t\t"chrome://global/content/elements/moz-card.mjs",\n\t],
]) {
  customElements.setElementCreationCallback(tag, () => {});
}
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).not.toContain('moz-banner');
    expect(after).toContain('moz-button');
    expect(after).toContain('moz-card');
  });

  it('handles entries with extra blank lines between them', async () => {
    const before = `for (let [tag, script] of [

    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],

    ["moz-banner", "chrome://global/content/elements/moz-banner.mjs"],

    ["moz-card", "chrome://global/content/elements/moz-card.mjs"],

]) {
  customElements.setElementCreationCallback(tag, () => {});
}
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).not.toContain('moz-banner');
    expect(after).toContain('moz-button');
    expect(after).toContain('moz-card');
  });

  it('handles inline comments after an entry', async () => {
    const before = `for (let [tag, script] of [
    ["moz-button", "chrome://global/content/elements/moz-button.mjs"],
    ["moz-banner", "chrome://global/content/elements/moz-banner.mjs"], // TODO: remove
    ["moz-card", "chrome://global/content/elements/moz-card.mjs"],
]) {
  customElements.setElementCreationCallback(tag, () => {});
}
`;
    const { engineDir, customElementsPath } = await makeEngineWithContent(before);

    await removeCustomElementRegistration(engineDir, 'moz-banner');

    const after = await readFile(customElementsPath, 'utf8');
    expect(after).not.toContain('moz-banner');
    expect(after).not.toContain('TODO: remove');
    expect(after).toContain('moz-button');
    expect(after).toContain('moz-card');
  });
});
