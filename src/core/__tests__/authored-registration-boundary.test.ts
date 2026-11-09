// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { sourceFixture, writeAt } from '../authored/__tests__/fixtures.js';
import { upstreamDeltas } from '../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../authored/capture.js';
import { evaluateAuthoredUpstreamPolicy } from '../patch-policy-content.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function deltasFor(
  edit: (value: Awaited<ReturnType<typeof sourceFixture>>) => Promise<void>
): Promise<{
  value: Awaited<ReturnType<typeof sourceFixture>>;
  deltas: Awaited<ReturnType<typeof upstreamDeltas>>;
}> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  await writeAt(
    value.root,
    '.fireforge-sources/overrides/browser/manifest.txt.json',
    JSON.stringify(value.declaration)
  );
  await edit(value);
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src'],
    pristineRepository: value.pristine,
  });
  const deltas = await upstreamDeltas(snapshot, value.pristine);
  return { value, deltas };
}

it('accepts an ordinary content edit of a registration override from a generated delta', async () => {
  const { value, deltas } = await deltasFor((v) =>
    writeAt(v.root, 'src/browser/manifest.txt', 'first\nlocal\nthird\nfourth\nfifth\n')
  );
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.diff).toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+ 100644$/m);
  expect(await evaluateAuthoredUpstreamPolicy(value.config, value.root, deltas)).toEqual([]);
});

it('still refuses an executable-bit change of a registration override from a generated delta', async () => {
  const { value, deltas } = await deltasFor((v) =>
    writeAt(v.root, 'src/browser/manifest.txt', 'first\nsecond\nthird\nfourth\nfifth\n', true)
  );
  const issues = await evaluateAuthoredUpstreamPolicy(value.config, value.root, deltas);
  expect(issues.some((issue) => issue.message.includes('mode changes'))).toBe(true);
});
