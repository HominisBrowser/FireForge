// SPDX-License-Identifier: EUPL-1.2
/**
 * An unregistered fork-owned system module must be named as text, not
 * surface later as a bare `xpcshell return code: -11`.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import {
  findUnresolvedSystemModuleImports,
  formatUnresolvedSystemModuleImports,
} from '../module-resolution-preflight.js';

describe('findUnresolvedSystemModuleImports', () => {
  let projectRoot: string;
  let engineDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-modres-');
    engineDir = join(projectRoot, 'engine');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('flags an import ADDED to an EXISTING module whose target is unregistered', async () => {
    // The exact recurrence: the importer is not new, so the queue-level
    // new-file rule is structurally blind to it.
    await writeFiles(engineDir, {
      'browser/modules/Existing.sys.mjs':
        'import { New } from "resource:///modules/NewThing.sys.mjs";\n',
      'browser/modules/NewThing.sys.mjs': 'export const New = 1;\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["Existing.sys.mjs"]\n',
    });

    const findings = await findUnresolvedSystemModuleImports(engineDir, [
      'browser/modules/Existing.sys.mjs',
      'browser/modules/NewThing.sys.mjs',
    ]);

    expect(findings).toEqual([
      {
        module: 'browser/modules/NewThing.sys.mjs',
        specifier: 'resource:///modules/NewThing.sys.mjs',
        importers: ['browser/modules/Existing.sys.mjs'],
        reason: 'unregistered',
      },
    ]);
    expect(formatUnresolvedSystemModuleImports(findings)[0]).toContain('EXTRA_JS_MODULES');
  });

  it('accepts a module registered in an ANCESTOR moz.build', async () => {
    await writeFiles(engineDir, {
      'browser/modules/Existing.sys.mjs':
        'import { New } from "resource:///modules/sub/NewThing.sys.mjs";\n',
      'browser/modules/sub/NewThing.sys.mjs': 'export const New = 1;\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["sub/NewThing.sys.mjs"]\n',
    });

    await expect(
      findUnresolvedSystemModuleImports(engineDir, [
        'browser/modules/Existing.sys.mjs',
        'browser/modules/sub/NewThing.sys.mjs',
      ])
    ).resolves.toEqual([]);
  });

  it('flags an owned module that is imported but absent from engine/', async () => {
    await writeFiles(engineDir, {
      'browser/modules/Existing.sys.mjs':
        'import { Gone } from "resource:///modules/Gone.sys.mjs";\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["Gone.sys.mjs"]\n',
    });

    const findings = await findUnresolvedSystemModuleImports(engineDir, [
      'browser/modules/Existing.sys.mjs',
      'browser/modules/Gone.sys.mjs',
    ]);

    expect(findings.map((f) => f.reason)).toEqual(['missing-file']);
    expect(formatUnresolvedSystemModuleImports(findings)[0]).toContain('does not exist in engine/');
  });

  it('does not police upstream modules the queue does not own', async () => {
    await writeFiles(engineDir, {
      'browser/modules/Existing.sys.mjs':
        'import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["Existing.sys.mjs"]\n',
    });

    await expect(
      findUnresolvedSystemModuleImports(engineDir, ['browser/modules/Existing.sys.mjs'])
    ).resolves.toEqual([]);
  });

  it('covers lazy ChromeUtils.defineESModuleGetters specifiers, not just static imports', async () => {
    // (related): a lazy getter that fails to resolve reports the
    // binding as `undefined` with no import error logged anywhere, so the
    // static-import-only view would miss exactly the shape that is hardest
    // to diagnose at runtime.
    await writeFiles(engineDir, {
      'browser/modules/Existing.sys.mjs': [
        'const lazy = {};',
        'ChromeUtils.defineESModuleGetters(lazy, {',
        '  NewThing: "resource:///modules/NewThing.sys.mjs",',
        '});',
        '',
      ].join('\n'),
      'browser/modules/NewThing.sys.mjs': 'export const New = 1;\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["Existing.sys.mjs"]\n',
    });

    const findings = await findUnresolvedSystemModuleImports(engineDir, [
      'browser/modules/Existing.sys.mjs',
      'browser/modules/NewThing.sys.mjs',
    ]);

    expect(findings.map((f) => f.module)).toEqual(['browser/modules/NewThing.sys.mjs']);
    expect(findings[0]?.reason).toBe('unregistered');
  });

  it('ignores specifiers that only appear inside comments', async () => {
    await writeFiles(engineDir, {
      'browser/modules/Existing.sys.mjs':
        '// import { New } from "resource:///modules/NewThing.sys.mjs";\n',
      'browser/modules/NewThing.sys.mjs': 'export const New = 1;\n',
      'browser/modules/moz.build': 'EXTRA_JS_MODULES += ["Existing.sys.mjs"]\n',
    });

    await expect(
      findUnresolvedSystemModuleImports(engineDir, [
        'browser/modules/Existing.sys.mjs',
        'browser/modules/NewThing.sys.mjs',
      ])
    ).resolves.toEqual([]);
  });
});
