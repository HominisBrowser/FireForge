// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateAdapterArguments } from '../adapter-arguments.js';
import { wantsKeepAwake } from '../keep-awake.js';
import {
  assertDeclaredEnvironment,
  assertStepDeclaration,
  declaredProcessEnvironment,
  parseEnvironmentAssignments,
  stepOutputDirectory,
} from '../step-environment.js';

const test = { command: 'test', args: ['--headless', 'a.js'] };

describe('a declared environment', () => {
  it.each([
    'FIREFORGE_JOB_TOKEN',
    'FIREFORGE_COORDINATOR',
    'PATH',
    'HOME',
    'TMPDIR',
    'NODE_OPTIONS',
    'NODE_PATH',
    'MOZ_UPLOAD_DIR',
    'MOZ_HEADLESS',
    'MOZCONFIG',
    'MOZBUILD_STATE_PATH',
    'MACHRC',
    'GIT_DIR',
    'PYTHONPATH',
    'PIP_CONFIG_FILE',
    'VIRTUAL_ENV',
    'DYLD_INSERT_LIBRARIES',
    'LD_PRELOAD',
    'CC',
    'CARGO',
    'RUSTC',
    'TSX_TSCONFIG_PATH',
    'BASH_ENV',
    'LC_ALL',
  ])('refuses %s', (name) => {
    expect(() => {
      assertDeclaredEnvironment({ [name]: 'x' });
    }).toThrow(/executor owns/);
  });

  it.each([['lower'], ['1A'], ['A-B'], ['A B'], [''], [`A${'B'.repeat(64)}`]])(
    'refuses the name %j',
    (name) => {
      expect(() => {
        assertDeclaredEnvironment({ [name]: 'x' });
      }).toThrow(/upper case/);
    }
  );

  it.each([
    ['/etc/passwd'],
    ['~/x'],
    ['../x'],
    ['a/../../x'],
    ['a=/b'],
    ['{artifacts}/../x'],
    ['x{artifacts}'],
    ['{artifacts}y'],
    ['{artifacts}/a{artifacts}'],
    ['two\nlines'],
    ['x'.repeat(4097)],
  ])('refuses the value %j', (value) => {
    expect(() => {
      assertDeclaredEnvironment({ PROJECT_VALUE: value });
    }).toThrow(/outside the job|one line/);
  });

  it('accepts a project name with plain values and paths into the job', () => {
    expect(() => {
      assertDeclaredEnvironment({
        PROJECT_CAPTURE: '1',
        PROJECT_DATA: 'tools/fixture.json',
        PROJECT_DIR: '{artifacts}/captures',
        PROJECT_ROOT_DIR: '{artifacts}',
        PROJECT_EMPTY: '',
      });
    }).not.toThrow();
  });

  it('applies only to a test or run with no build in it', () => {
    const env = { PROJECT_CAPTURE: '1' };
    expect(() => {
      assertStepDeclaration({ ...test, env, uploadDir: true, keepAwake: true });
    }).not.toThrow();
    expect(() => {
      assertStepDeclaration({ command: 'run', args: ['--headless'], env });
    }).not.toThrow();
    for (const step of [
      { command: 'build', args: [] },
      { command: 'check', args: [] },
      { command: 'test', args: ['--build', 'a.js'] },
      { command: 'test', args: ['--build-only', 'a.js'] },
    ]) {
      expect(() => {
        assertStepDeclaration({ ...step, env });
      }).toThrow(/test or run/);
      expect(() => {
        assertStepDeclaration({ ...step, uploadDir: true });
      }).toThrow(/test or run/);
      expect(() => {
        assertStepDeclaration({ ...step, keepAwake: true });
      }).not.toThrow();
    }
    expect(() => {
      assertStepDeclaration({ ...test, uploadDir: 'yes' as unknown as boolean });
    }).toThrow(/uploadDir/);
  });

  it('fills the output directory in, and gives no directory to a step that writes none', () => {
    const declared = {
      ...test,
      env: { PROJECT_DIR: '{artifacts}/captures', PROJECT_CAPTURE: '1' },
      uploadDir: true,
    };
    const output = stepOutputDirectory('/ns', 'job', 2, declared);
    expect(output).toBe('/ns/artifacts/job/step-2-output');
    expect(declaredProcessEnvironment(declared, output)).toEqual({
      PROJECT_DIR: '/ns/artifacts/job/step-2-output/captures',
      PROJECT_CAPTURE: '1',
      MOZ_UPLOAD_DIR: '/ns/artifacts/job/step-2-output',
    });
    expect(stepOutputDirectory('/ns', 'job', 2, test)).toBeUndefined();
    expect(
      stepOutputDirectory('/ns', 'job', 2, { ...test, env: { PROJECT_CAPTURE: '1' } })
    ).toBeUndefined();
    expect(declaredProcessEnvironment(test, undefined)).toEqual({});
  });

  it('reads NAME=VALUE, keeping any further = in the value', () => {
    expect(parseEnvironmentAssignments(['PROJECT_A=1', 'PROJECT_B=x=y', 'PROJECT_C='])).toEqual({
      PROJECT_A: '1',
      PROJECT_B: 'x=y',
      PROJECT_C: '',
    });
    expect(() => parseEnvironmentAssignments(['PROJECT_A'])).toThrow(/NAME=VALUE/);
    expect(() => parseEnvironmentAssignments(['=x'])).toThrow(/NAME=VALUE/);
    expect(() => parseEnvironmentAssignments(['PATH=x'])).toThrow(/executor owns/);
  });
});

describe('a job’s mach arguments', () => {
  const validate = (...args: string[]): void => {
    validateAdapterArguments({ command: 'test', args: [...args, 'a.js'] });
  };

  it('admits a pref in either spelling', () => {
    validate('--mach-arg=--setpref=focusmanager.testmode=true');
    validate('--mach-arg', '--setpref=toolkit.legacyUserProfileCustomizations.stylesheets=true');
    validate('--mach-arg=--setpref=a.b=');
  });

  it.each([
    '--mach-arg=--log-raw=x.json',
    '--mach-arg=--setenv=PATH=x',
    '--mach-arg=--profile=x',
    '--mach-arg=--setpref=novalue',
    '--mach-arg=--setpref=marionette.port=2828',
    '--mach-arg=--setpref=a=/etc',
    '--mach-arg=--setpref=a=x y',
    '--mach-arg=',
    '--mach-arg',
  ])('refuses %s', (arg) => {
    expect(() => {
      validate(arg);
    }).toThrow(/Unsupported immutable-job option/);
  });

  it('is an option of a test, and of nothing else', () => {
    expect(() => {
      validateAdapterArguments({ command: 'build', args: ['--mach-arg=--setpref=a=1'] });
    }).toThrow(/Unsupported immutable-job option/);
    expect(() => {
      validateAdapterArguments({ command: 'run', args: ['--mach-arg=--setpref=a=1'] });
    }).toThrow(/Unsupported immutable-job option/);
  });
});

describe('who holds the keep-awake assertion', () => {
  it('a step with a window, unless it declines; anything else, if it asks', () => {
    expect(wantsKeepAwake({ command: 'test', args: ['a.js'] })).toBe(true);
    expect(wantsKeepAwake({ command: 'run', args: [] })).toBe(true);
    expect(wantsKeepAwake({ command: 'test', args: ['--headless', 'a.js'] })).toBe(false);
    expect(wantsKeepAwake({ command: 'build', args: [] })).toBe(false);
    expect(wantsKeepAwake({ command: 'test', args: ['a.js'], keepAwake: false })).toBe(false);
    expect(wantsKeepAwake({ command: 'build', args: [], keepAwake: true })).toBe(true);
  });
});

describe('what a step may declare', () => {
  it('throttles only a test with no build in it', () => {
    expect(() => {
      assertStepDeclaration({ ...test, throttle: 'background' });
    }).not.toThrow();
    expect(() => {
      assertStepDeclaration({ ...test, throttle: 'nonsense' as never });
    }).toThrow(/throttle must be one of/);
    expect(() => {
      assertStepDeclaration({ command: 'status', args: [], throttle: 'utility' });
    }).toThrow(/throttle applies to a test/);
    expect(() => {
      assertStepDeclaration({ ...test, args: ['--build', 'a.js'], throttle: 'utility' });
    }).toThrow(/throttle applies to a test/);
  });
});

describe('what an adapter takes', () => {
  it.each([
    ['a run of a page by URL', { command: 'run', args: ['about:blank'] }],
    ['a furnace action', { command: 'furnace', args: ['validate'] }],
    ['the release recipe', { command: 'package', args: ['--recipe', 'release'] }],
  ])('takes %s', (_name, step) => {
    expect(() => {
      validateAdapterArguments(step);
    }).not.toThrow();
  });

  it.each([
    ['an unknown adapter', { command: 'nonsense', args: [] }, /Unsupported job adapter/],
    ['a run of a file', { command: 'run', args: ['./page.html'] }, /typed captured adapter/],
    ['a furnace with no action', { command: 'furnace', args: [] }, /names its action/],
    ['another furnace action', { command: 'furnace', args: ['rm'] }, /furnace job action/],
    ['another recipe', { command: 'package', args: ['--recipe', 'x'] }, /only package recipe/],
    ['a flag it does not know', { command: 'build', args: ['--nope'] }, /Unsupported immutable/],
    ['a flag missing its value', { command: 'package', args: ['--recipe'] }, /Missing admitted/],
  ])('refuses %s', (_name, step, message) => {
    expect(() => {
      validateAdapterArguments(step);
    }).toThrow(message);
  });
});
