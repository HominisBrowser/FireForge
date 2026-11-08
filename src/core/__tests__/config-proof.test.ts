// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { parseProofConfig } from '../config-validate-proof.js';

describe('the proof config block', () => {
  it('takes a closed validator, a recipe and what an acceptance looks at', () => {
    const value = {
      gate: {
        mode: 'release',
        lanes: [
          {
            id: 'captures',
            files: ['browser/tiles/browser_captures.js'],
            uploadDir: true,
            validate: {
              command: ['node', 'tools/count.mjs', '--from={artifacts}/captures'],
              footprint: { cpu: 2, memory: 6 },
            },
          },
        ],
        acceptance: [{ id: 'scene', reason: 'A person looks.', evidence: ['lane:captures'] }],
      },
    };
    expect(parseProofConfig(value)).toEqual(value);
  });

  it('states a whole gate: browser lanes, stress with context, controls, acceptance and a check', () => {
    const value = {
      mainBranch: 'main',
      consumerLimit: 20,
      noneRoutes: ['tools/**'],
      gate: {
        build: 'ui',
        check: { quiet: true },
        lanes: [
          { id: 'unit', files: ['browser/unit/test_*.js'] },
          {
            id: 'tiles',
            files: ['browser/tiles/browser_*.js'],
            exclude: ['browser/tiles/browser_fullscreen.js'],
            dispatch: 'one-browser',
            quiet: true,
            owns: ['browser/tiles/**'],
            args: ['--harness-retries', '0'],
          },
          { id: 'scenes', files: ['browser/tiles/browser_scene.js'], dispatch: 'standalone' },
          { id: 'fullscreen', files: ['browser/tiles/browser_fullscreen.js'], headed: true },
          {
            id: 'captures',
            files: ['browser/tiles/browser_captures.js'],
            env: { PROJECT_CAPTURE: '1', PROJECT_DIR: '{artifacts}/captures' },
            uploadDir: true,
            machArgs: ['--setpref=focusmanager.testmode=true'],
            keepAwake: false,
          },
        ],
        stress: [
          {
            id: 'tiles',
            files: ['browser/tiles/browser_a.js'],
            context: ['browser/tiles/browser_0.js'],
            repeat: 10,
            quiet: true,
          },
        ],
        controls: [
          {
            id: 'guard',
            diff: 'tools/controls/guard.diff',
            test: 'browser/tiles/browser_a.js',
            assertions: ['guard holds'],
            compiled: true,
            always: true,
          },
        ],
        runs: [
          {
            id: 'smoke',
            args: [
              '--smoke-exit',
              '30',
              '--console-allow-file',
              'tools/a.txt',
              '--capture-console',
              '{artifacts}/console.txt',
            ],
            env: { PROJECT_SMOKE: '1' },
            uploadDir: true,
            keepAwake: true,
            validate: { command: ['node', 'tools/check-console.mjs', '{artifacts}/console.txt'] },
          },
        ],
        acceptance: [{ id: 'scene', reason: 'A person looks.', owns: ['browser/themes/**'] }],
      },
    };
    expect(parseProofConfig(value)).toEqual(value);
  });

  it.each([
    [{ gates: {} }, /unknown key "gates"/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], bindings: [] }] } }, /unknown key "bindings"/],
    [{ gate: { lanes: [{ id: 'a', files: [] }] } }, /files/],
    [{ gate: { lanes: [{ id: 'a' }] } }, /files/],
    [{ gate: { lanes: [{ id: 'A b', files: ['x'] }] } }, /lower-case/],
    [
      {
        gate: {
          lanes: [
            { id: 'a', files: ['x'] },
            { id: 'a', files: ['y'] },
          ],
        },
      },
      /unique/,
    ],
    [{ gate: { lanes: [{ id: 'a', files: ['../x'] }] } }, /project-relative/],
    [{ gate: { lanes: [{ id: 'a', files: ['/x'] }] } }, /project-relative/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], dispatch: 'chunks' }] } }, /dispatch/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], args: ['--mach-arg', 'y'] }] } }, /refused/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], args: ['x.js'] }] } }, /refused/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], args: ['--no-shard'] }] } }, /--no-shard/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], args: ['--repeat', '9'] }] } }, /--repeat/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], args: ['--build'] }] } }, /--build/],
    [
      { gate: { lanes: [{ id: 'a', files: ['x'], args: ['--mach-arg=--setpref=a=1'] }] } },
      /--mach-arg|machArgs/,
    ],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: { PATH: '/x' } }] } }, /executor owns/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: { MOZ_UPLOAD_DIR: 'x' } }] } }, /uploadDir/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: { FIREFORGE_X: 'x' } }] } }, /executor owns/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: { lower: 'x' } }] } }, /upper case/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: ['A=1'] }] } }, /refused/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: { A: 1 } }] } }, /one line/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], env: { A: '/etc' } }] } }, /outside the job/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], uploadDir: 'yes' }] } }, /uploadDir/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], keepAwake: 'yes' }] } }, /keepAwake/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], machArgs: ['--log-raw=x'] }] } }, /refused/],
    [
      { gate: { lanes: [{ id: 'a', files: ['x'], machArgs: ['--setpref=marionette.port=1'] }] } },
      /refused/,
    ],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], machArgs: [] }] } }, /machArgs/],
    [
      { gate: { controls: [{ id: 'a', diff: 'd', test: 't', assertions: ['x'], always: 1 }] } },
      /always/,
    ],
    [{ gate: { runs: [{ id: 'a', args: ['--headless'], env: { HOME: 'x' } }] } }, /executor owns/],
    [
      { gate: { runs: [{ id: 'a', args: ['--headless'], machArgs: ['--setpref=a=1'] }] } },
      /unknown key/,
    ],
    [{ gate: { stress: [{ id: 'a', files: ['x'] }] } }, /repeat/],
    [{ gate: { stress: [{ id: 'a', files: ['x'], repeat: 0 }] } }, /repeat/],
    [{ gate: { controls: [{ id: 'a', diff: 'd', test: 't' }] } }, /assertions/],
    [{ gate: { acceptance: [{ id: 'a' }] } }, /reason/],
    [{ gate: { runs: [{ id: 'a' }] } }, /args/],
    [{ gate: { runs: [{ id: 'a', args: ['-P', 'x'] }] } }, /refused/],
    [
      { gate: { runs: [{ id: 'a', args: ['--headless'], validate: { command: ['sh'] } }] } },
      /program name/,
    ],
    [{ gate: { build: 'fast' } }, /build/],
    [{ gate: { mode: 'fast' } }, /dev, debug or release/],
    [{ gate: { acceptance: [{ id: 'proof-config', reason: 'r' }] } }, /FireForge plans that one/],
    [
      { gate: { acceptance: [{ id: 'a', reason: 'r', evidence: ['lane:nope'] }] } },
      /does not declare/,
    ],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], validate: { command: 'node x' } }] } }, /argument/],
    [{ gate: { lanes: [{ id: 'a', files: ['x'], validate: { command: [] } }] } }, /argument/],
    [
      { gate: { lanes: [{ id: 'a', files: ['x'], validate: { command: ['sh'] } }] } },
      /program name/,
    ],
    [
      { gate: { lanes: [{ id: 'a', files: ['x'], validate: { command: ['node', '/etc/x'] } }] } },
      /outside the job/,
    ],
    [
      { gate: { lanes: [{ id: 'a', files: ['x'], validate: { command: ['t/x'], shell: true } }] } },
      /does not take shell/,
    ],
    [
      {
        gate: {
          lanes: [{ id: 'a', files: ['x'], validate: { command: ['t/x'], footprint: { cpu: 0 } } }],
        },
      },
      /positive/,
    ],
    [{ gate: { check: { skip: true } } }, /unknown key "skip"/],
    [{ consumerLimit: 0 }, /consumerLimit/],
    ['gate', /must be an object/],
  ])('refuses %j', (raw, message) => {
    expect(() => parseProofConfig(raw)).toThrow(message);
  });
});
