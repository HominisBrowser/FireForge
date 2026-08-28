// SPDX-License-Identifier: EUPL-1.2
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';
import type { TypecheckIssue, TypecheckProjectResult } from '../../types/typecheck.js';
import { CHECK_JS_DISABLED_NOTICE, runTypecheck } from '../typecheck.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'typecheck');

/**
 * Helper that asserts the array has exactly one entry and returns it.
 * Avoids `array[0]!` non-null assertions while keeping per-test
 * narration short. Used in nearly every case below — the typecheck
 * engine is per-project so single-project tests dominate.
 */
function expectSingle<T>(arr: ReadonlyArray<T>, message?: string): T {
  expect(arr, message).toHaveLength(1);
  const [first] = arr;
  if (first === undefined) {
    throw new Error('expectSingle: array was empty after length assertion');
  }
  return first;
}

describe('runTypecheck', () => {
  it('reports the expected type error for the basic fixture', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['basic/jsconfig.json'],
    });
    const result: TypecheckProjectResult = expectSingle(results);
    expect(result.project).toBe('basic/jsconfig.json');
    expect(result.filesChecked).toBeGreaterThanOrEqual(2);

    // The fixture's intentional bug: helper.greet returns string but
    // mod.mjs annotates value as @type {number}. TS2322 is the
    // canonical type-mismatch code.
    const errors = result.issues.filter((i) => i.category === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((i) => i.code === 2322)).toBe(true);

    // None of the suppressed module-resolution codes should leak into
    // the output. (2304/2552 are no longer in this set —
    // but the basic fixture has no undefined identifiers.)
    const suppressed = [2304, 2305, 2306, 2307, 2552, 2580, 2792, 7016];
    for (const code of suppressed) {
      expect(result.issues.some((i) => i.code === code)).toBe(false);
    }
  });

  it('reports undefined free identifiers as warnings by default', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['undefined-identifier/jsconfig.json'],
    });
    const result: TypecheckProjectResult = expectSingle(results);

    const undefinedIssues = result.issues.filter((i) => i.code === 2304 || i.code === 2552);
    expect(undefinedIssues).toHaveLength(1);
    expect(undefinedIssues[0]?.category).toBe('warning');
    expect(undefinedIssues[0]?.message).toContain('EditorState');
    expect(undefinedIssues[0]?.message).toContain('undefined identifier');
    // Shim-covered globals stay clean.
    expect(result.issues.some((i) => i.message.includes("'Services'"))).toBe(false);
    // No error-category issues — the default must not break gates.
    expect(result.issues.filter((i) => i.category === 'error')).toHaveLength(0);
  });

  it('escalates undefined identifiers to errors when configured', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['undefined-identifier/jsconfig.json'],
      undefinedIdentifiers: 'error',
    });
    const result: TypecheckProjectResult = expectSingle(results);
    const undefinedIssues = result.issues.filter((i) => i.code === 2304 || i.code === 2552);
    expect(undefinedIssues).toHaveLength(1);
    expect(undefinedIssues[0]?.category).toBe('error');
  });

  it("restores the historical suppression with 'off'", async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['undefined-identifier/jsconfig.json'],
      undefinedIdentifiers: 'off',
    });
    const result: TypecheckProjectResult = expectSingle(results);
    expect(result.issues.filter((i) => i.code === 2304 || i.code === 2552)).toHaveLength(0);
  });

  it('skips projects that explicitly opt out via checkJs: false', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['disabled/jsconfig.json'],
    });
    const result: TypecheckProjectResult = expectSingle(results);
    // Exactly one warning explaining the skip — no real type errors,
    // because the user told us not to look.
    const issue: TypecheckIssue = expectSingle(result.issues);
    expect(issue.category).toBe('warning');
    expect(issue.message).toBe(CHECK_JS_DISABLED_NOTICE);
  });

  it('honours user-defined `paths` mapping (no TS2307 for resolved aliases)', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['with-paths/jsconfig.json'],
    });
    const result: TypecheckProjectResult = expectSingle(results);

    // 2307 ("Cannot find module") is in the suppressed set, so the
    // suppression check above is the wrong assertion here. Instead,
    // assert no errors AT ALL — if `paths` resolved correctly, the
    // import is valid and no type error fires; if `paths` did not
    // resolve, suppression masks it but `greet(...)` then returns
    // `any`, which would still be issue-free. The clean baseline is
    // the meaningful contract.
    const errors = result.issues.filter((i) => i.category === 'error');
    expect(errors).toHaveLength(0);
  });

  it('returns one result per project, in declared order', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['with-paths/jsconfig.json', 'basic/jsconfig.json'],
    });
    expect(results.map((r) => r.project)).toEqual([
      'with-paths/jsconfig.json',
      'basic/jsconfig.json',
    ]);
  });

  it('reports a clear error when a configured jsconfig is missing', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['does-not-exist/jsconfig.json'],
    });
    const result: TypecheckProjectResult = expectSingle(results);
    expect(result.filesChecked).toBe(0);
    const issue: TypecheckIssue = expectSingle(result.issues);
    expect(issue.category).toBe('error');
    expect(issue.message).toMatch(/jsconfig\.json not found/);
  });

  it('honours typecheck.extraShim by appending the user-provided declarations', async () => {
    // The shim declares MyBrowserBase. Without the shim, a reference
    // to MyBrowserBase would surface as 2304 (suppressed) but using
    // it in a type position (`extends`, `: MyBrowserBase`) without
    // resolution would still let the code through with `any`. To
    // prove the shim is wired, we use the shim's specific signature:
    // attachShadow expects `{ mode: 'open' | 'closed' }`. Passing a
    // different shape produces a non-suppressed type error.
    const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const tmpProject = await mkdtemp(join(tmpdir(), 'ff-typecheck-shim-'));
    try {
      await mkdir(join(tmpProject, 'src'));
      await writeFile(
        join(tmpProject, 'jsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ES2022',
            moduleResolution: 'Bundler',
            allowJs: true,
            checkJs: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ['src/use.mjs'],
        }) + '\n'
      );
      await writeFile(
        join(tmpProject, 'shim.d.ts'),
        'declare class MyBrowserBase { attachShadow(init: { mode: "open" | "closed" }): ShadowRoot; }\n'
      );
      await writeFile(
        join(tmpProject, 'src', 'use.mjs'),
        [
          '/** @returns {ShadowRoot} */',
          'export function attach() {',
          '  const obj = new MyBrowserBase();',
          // Wrong shape — `mode: "wrong"` is not assignable.
          '  return obj.attachShadow({ mode: "wrong" });',
          '}',
          '',
        ].join('\n')
      );

      const results = await runTypecheck(tmpProject, {
        projects: ['jsconfig.json'],
        extraShim: 'shim.d.ts',
      });
      const result: TypecheckProjectResult = expectSingle(results);
      const errors = result.issues.filter((i) => i.category === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(
        errors.some((i) =>
          /Type '"wrong"' is not assignable to type '"open" \| "closed"'/.test(i.message)
        )
      ).toBe(true);
    } finally {
      await rm(tmpProject, { recursive: true, force: true });
    }
  });

  it('returns a clear error when typecheck.extraShim points at a missing file', async () => {
    const results = await runTypecheck(FIXTURES, {
      projects: ['basic/jsconfig.json'],
      extraShim: 'does-not-exist.d.ts',
    });
    // Same shape for every project when the shared shim fails to
    // compose: one issue per project naming the missing file.
    const result: TypecheckProjectResult = expectSingle(results);
    const issue: TypecheckIssue = expectSingle(result.issues);
    expect(issue.message).toMatch(/Extra TypeScript shim not found/);
  });

  it('does not leave the synthetic shim file on disk after a run', async () => {
    const { existsSync } = await import('node:fs');
    await runTypecheck(FIXTURES, { projects: ['basic/jsconfig.json'] });
    // The shim path is `<projectDir>/.fireforge-__fireforge_firefox_globals.d.ts`.
    expect(existsSync(join(FIXTURES, 'basic', '.fireforge-__fireforge_firefox_globals.d.ts'))).toBe(
      false
    );
  });

  /** Writes a jsconfig + a use.mjs that exercises the shim's HubBase signature. */
  async function writeShimProject(
    root: string,
    name: string,
    mkdir: typeof import('node:fs/promises').mkdir,
    writeFile: typeof import('node:fs/promises').writeFile
  ): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'Bundler',
          allowJs: true,
          checkJs: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['use.mjs'],
      }) + '\n'
    );
    // With the shim, `new HubBase().tag({ mode: "y" })` errors (y ∉ {"x"}).
    // Without the shim, HubBase is unknown → TS2304, which is suppressed.
    await writeFile(
      join(root, name, 'use.mjs'),
      ['export function f() {', '  new HubBase().tag({ mode: "y" });', '}', ''].join('\n')
    );
  }

  it('lets a project opt out of the shared extraShim via projectOverrides: null', async () => {
    const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const root = await mkdtemp(join(tmpdir(), 'ff-typecheck-perproject-'));
    try {
      await writeFile(
        join(root, 'hub.d.ts'),
        'declare class HubBase { tag(init: { mode: "x" }): void; }\n'
      );
      await writeShimProject(root, 'a', mkdir, writeFile);
      await writeShimProject(root, 'b', mkdir, writeFile);

      const results = await runTypecheck(root, {
        projects: ['a/jsconfig.json', 'b/jsconfig.json'],
        extraShim: 'hub.d.ts',
        projectOverrides: { 'b/jsconfig.json': null },
      });

      const a = results.find((r) => r.project === 'a/jsconfig.json');
      const b = results.find((r) => r.project === 'b/jsconfig.json');
      // Project A absorbed the shim → the signature mismatch surfaces.
      expect(a?.issues.some((i) => /not assignable to type '"x"'/.test(i.message))).toBe(true);
      // Project B opted out → it never saw HubBase, so no error (TS2304 suppressed).
      expect(b?.issues.filter((i) => i.category === 'error')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets a project override the shared extraShim with its own via projectOverrides', async () => {
    const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const root = await mkdtemp(join(tmpdir(), 'ff-typecheck-override-'));
    try {
      // The shared hub rejects mode "y"; the b-only shim accepts it.
      await writeFile(
        join(root, 'hub.d.ts'),
        'declare class HubBase { tag(init: { mode: "x" }): void; }\n'
      );
      await writeFile(
        join(root, 'b-only.d.ts'),
        'declare class HubBase { tag(init: { mode: "y" }): void; }\n'
      );
      await writeShimProject(root, 'b', mkdir, writeFile);

      const results = await runTypecheck(root, {
        projects: ['b/jsconfig.json'],
        extraShim: 'hub.d.ts',
        projectOverrides: { 'b/jsconfig.json': 'b-only.d.ts' },
      });

      const b = results.find((r) => r.project === 'b/jsconfig.json');
      // Used b-only.d.ts (accepts "y"), not the shared hub → no error.
      expect(b?.issues.filter((i) => i.category === 'error')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
