// SPDX-License-Identifier: EUPL-1.2
/**
 * Several controls on one workspace through a session: the build of the
 * restored engine happens once, after the last control, and the unmutated
 * runs happen before the first mutation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Workspace } from '../engine/index.js';
import { useMachSandbox } from '../testing/engine.js';
import { readMachLog, scriptMach } from '../testing/firefox.js';
import { harnessScript, makeTestWorkspace, TEST_PATHS } from '../testing/harness.js';
import { useTempDir } from '../testing/temp.js';
import { controlSession, proveBaselines, runControl, settleControls } from './control.js';
import { planTests } from './plan.js';
import { runTests } from './run.js';

const dir = useTempDir();
useMachSandbox();

const { browserA: A, browserB: B } = TEST_PATHS;
const BROWSER_JS = 'browser/base/content/browser.js';

const uiDiff = (to: string): string =>
  [
    `diff --git a/${BROWSER_JS} b/${BROWSER_JS}`,
    `--- a/${BROWSER_JS}`,
    `+++ b/${BROWSER_JS}`,
    '@@ -1 +1 @@',
    '-export const browserTitle = "baseline";',
    `+export const browserTitle = "${to}";`,
    '',
  ].join('\n');

const count = async (ws: Workspace, command: string): Promise<number> =>
  (await readMachLog(ws.engineDir)).filter((call) => call.args[0] === command).length;

describe('controls through a session', () => {
  it('builds the restored engine once for all of them, and runs each baseline before any mutation', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A, B]));
    const first = join(dir(), 'first.diff');
    const second = join(dir(), 'second.diff');
    await writeFile(first, uiDiff('first'));
    await writeFile(second, uiDiff('second'));
    const planA = await planTests(ws.engineDir, { paths: [A] });
    const planB = await planTests(ws.engineDir, { paths: [B] });
    const builds = await count(ws, 'build');
    const runs = await count(ws, 'mochitest');

    const session = controlSession();
    await proveBaselines(ws, [planA, planB, planA], session);
    expect(await count(ws, 'mochitest')).toBe(runs + 2);

    const one = await runControl(ws, planA, { diff: first, expect: ['x'] }, {}, session);
    expect(one).toMatchObject({ outcome: 'missed', restoreBuild: 'deferred' });
    expect(one.baseline?.pass).toBe(true);
    expect(session.restoreOwed).toBe(true);
    const two = await runControl(ws, planB, { diff: second, expect: ['x'] }, {}, session);
    expect(two).toMatchObject({ outcome: 'missed', restoreBuild: 'deferred' });
    // Each mutation built; the restored engine is not built between them.
    expect(await count(ws, 'build')).toBe(builds + 2);
    expect(await count(ws, 'mochitest')).toBe(runs + 4);

    expect(await settleControls(ws, session)).toBe('done');
    expect(await count(ws, 'build')).toBe(builds + 3);
    expect(await settleControls(ws, session)).toBeUndefined();
    expect(await readFile(join(ws.engineDir, BROWSER_JS), 'utf8')).toBe(
      'export const browserTitle = "baseline";\n'
    );
    // The build matches the restored engine: tests run without building first.
    expect((await runTests(ws, planA)).pass).toBe(true);
  });

  it('builds the restored engine itself when the next control needs a baseline it does not have', async () => {
    const ws = await makeTestWorkspace(dir());
    await scriptMach(ws.engineDir, 'mochitest', harnessScript([A, B]));
    const first = join(dir(), 'first.diff');
    await writeFile(first, uiDiff('first'));
    const session = controlSession();
    await runControl(
      ws,
      await planTests(ws.engineDir, { paths: [A] }),
      { diff: first, expect: ['x'] },
      {},
      session
    );
    const builds = await count(ws, 'build');
    const other = await runControl(
      ws,
      await planTests(ws.engineDir, { paths: [B] }),
      { diff: first, expect: ['x'] },
      {},
      session
    );
    expect(other.baseline?.built).toBe('ui');
    expect(await count(ws, 'build')).toBe(builds + 2);
  });
});
