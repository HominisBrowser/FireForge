// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../errors/config.js';
import {
  cacheTargetProblem,
  parseBuildRelease,
  parseSlotsConfig,
} from '../config-validate-slots.js';

describe('slots.dependencyCaches', () => {
  it('takes source, target and an optional lockfile', () => {
    const caches = [
      { source: 'engine/node_modules', target: 'engine/node_modules' },
      { source: 'kit/dist', target: 'kit/dist', lockfile: 'kit/package-lock.json' },
    ];
    expect(parseSlotsConfig({ dependencyCaches: caches })).toEqual({ dependencyCaches: caches });
    expect(parseSlotsConfig({})).toEqual({});
  });

  it.each([
    ['an unknown key', { dependencyCaches: [{ source: 'a', target: 'a', other: 1 }] }],
    ['a path leaving the project', { dependencyCaches: [{ source: '../a', target: 'a' }] }],
    ['an absolute target', { dependencyCaches: [{ source: 'a', target: '/a' }] }],
    ['the engine itself', { dependencyCaches: [{ source: 'a', target: 'engine' }] }],
    ['an object directory', { dependencyCaches: [{ source: 'a', target: 'engine/obj-x/y' }] }],
    ['private state', { dependencyCaches: [{ source: 'a', target: '.fireforge/a' }] }],
    [
      'a repeated target',
      {
        dependencyCaches: [
          { source: 'a', target: 'a' },
          { source: 'b', target: 'a' },
        ],
      },
    ],
    ['a list that is not one', { dependencyCaches: 'a' }],
    ['another key', { caches: [] }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseSlotsConfig(raw)).toThrow(ConfigError);
  });
});

describe('a dependency tree target', () => {
  it.each([
    '.',
    './engine',
    'engine',
    'engine/',
    'engine/.',
    'x/../engine',
    'x/../y',
    '../x',
    '/abs',
    'a//b',
    'a/',
    'a\\b',
    'Engine',
    'ENGINE/browser',
    'ENGINE/node_modules',
    'engine/browser/themes/shared',
    'engine/obj-x/node_modules',
    'engine/OBJ-x/node_modules',
    'engine/node_modules/x',
    'engine/NODE_MODULES',
    '.git',
    '.GIT',
    '.git/x',
    '.fireforge',
    '.FIREFORGE/a',
    'vendor/.git/x',
  ])('refuses %s', (target) => {
    expect(cacheTargetProblem(target)).toBeDefined();
    expect(() => parseSlotsConfig({ dependencyCaches: [{ source: 'a', target }] })).toThrow(
      ConfigError
    );
  });

  it.each([
    'node_modules',
    'vendor/py',
    'kit/dist',
    'engine/node_modules',
    'engine/a/node_modules',
  ])('takes %s', (target) => {
    expect(cacheTargetProblem(target)).toBeUndefined();
  });

  it.each(['./a', 'x/../a', '.', 'a/'])('refuses a source or lockfile spelled %s', (path) => {
    expect(() => parseSlotsConfig({ dependencyCaches: [{ source: path, target: 'a' }] })).toThrow(
      ConfigError
    );
    expect(() =>
      parseSlotsConfig({ dependencyCaches: [{ source: 'a', target: 'a', lockfile: path }] })
    ).toThrow(ConfigError);
  });
});

describe('build.release', () => {
  it('takes a captured overlay and one declared set of secrets', () => {
    const release = {
      overlay: 'configs/release.mozconfig',
      secrets: { variable: 'HOMINIS_SECRETS_DIR', files: ['google-safebrowsing-api.key'] },
    };
    expect(parseBuildRelease(release)).toEqual(release);
    expect(parseBuildRelease({ overlay: 'a' })).toEqual({ overlay: 'a' });
  });

  it('takes the outputs a release hands back, as paths in its object directory', () => {
    const release = {
      overlay: 'a',
      outputs: ['dist/Hominis.app', 'dist/*.dmg', 'dist/host/bin/mar', 'config.status'],
    };
    expect(parseBuildRelease(release)).toEqual(release);
  });

  it.each([
    ['no overlay', {}],
    ['an overlay outside the project', { overlay: '/etc/mozconfig' }],
    ['a variable that is no name', { overlay: 'a', secrets: { variable: 'a b', files: [] } }],
    ['a secret path', { overlay: 'a', secrets: { variable: 'A', files: ['../key'] } }],
    ['another key', { overlay: 'a', objdir: 'b' }],
    ['no outputs listed', { overlay: 'a', outputs: [] }],
    ['an output outside the object directory', { overlay: 'a', outputs: ['../dist'] }],
    ['an absolute output', { overlay: 'a', outputs: ['/dist'] }],
    ['a pattern before the last segment', { overlay: 'a', outputs: ['dist/*/bin'] }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseBuildRelease(raw)).toThrow(ConfigError);
  });
});
