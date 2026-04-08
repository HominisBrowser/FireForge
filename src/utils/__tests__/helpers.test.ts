// SPDX-License-Identifier: EUPL-1.2
import { stripVTControlCharacters } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { countRawCssColors, escapeRegex, hasRawCssColors, stripJsComments } from '../regex.js';

function stripAnsi(value: string): string {
  return stripVTControlCharacters(value);
}

const promptMocks = vi.hoisted(() => {
  const spinnerStart = vi.fn();
  const spinnerStop = vi.fn();
  const spinnerMessage = vi.fn();

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    isCancel: vi.fn(() => false),
    spinnerStart,
    spinnerStop,
    spinnerMessage,
    spinner: vi.fn(() => ({
      start: spinnerStart,
      stop: spinnerStop,
      message: spinnerMessage,
    })),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  };
});

vi.mock('@clack/prompts', () => promptMocks);

const osMocks = vi.hoisted(() => ({
  platform: vi.fn(),
  arch: vi.fn(),
}));

vi.mock('node:os', () => osMocks);

import {
  cancel,
  error,
  formatErrorText,
  formatSuccessText,
  info,
  intro,
  isCancel,
  message,
  note,
  outro,
  setVerbose,
  spinner,
  step,
  success,
  verbose,
  warn,
} from '../logger.js';
import {
  getArch,
  getExecutableExtension,
  getMozconfigName,
  getPlatform,
  isDarwin,
  isLinux,
  isWindows,
} from '../platform.js';

describe('regex helpers', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a+b?.js')).toBe('a\\+b\\?\\.js');
  });

  it('detects and counts raw CSS color values', () => {
    const css = 'color: #fff; background: rgb(0, 0, 0); border-color: hsl(0 0% 0%);';
    expect(hasRawCssColors(css)).toBe(true);
    expect(countRawCssColors(css)).toBe(3);
  });

  it('strips JS comments while preserving string literals', () => {
    const source = 'const url = "https://example.test"; // comment\n/* block */ const ok = true;';
    const stripped = stripJsComments(source);
    expect(stripped).toContain('"https://example.test"');
    expect(stripped).not.toContain('// comment');
    expect(stripped).not.toContain('/* block */');
  });
});

describe('platform helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns supported platforms and Windows executable suffixes', () => {
    osMocks.platform.mockReturnValue('win32');
    expect(getPlatform()).toBe('win32');
    expect(getExecutableExtension()).toBe('.exe');
  });

  it('returns supported architectures and platform-derived helpers', () => {
    osMocks.platform.mockReturnValue('darwin');
    osMocks.arch.mockReturnValue('arm64');

    expect(getArch()).toBe('arm64');
    expect(getMozconfigName()).toBe('darwin.mozconfig');
    expect(isDarwin()).toBe(true);
    expect(isLinux()).toBe(false);
    expect(isWindows()).toBe(false);
    expect(getExecutableExtension()).toBe('');
  });

  it('throws for unsupported platforms and architectures', () => {
    osMocks.platform.mockReturnValue('freebsd');
    expect(() => getPlatform()).toThrow(/Unsupported platform: freebsd/);

    osMocks.arch.mockReturnValue('ia32');
    expect(() => getArch()).toThrow(/Unsupported architecture: ia32/);
  });
});

describe('logger helpers', () => {
  const stdoutTTY = process.stdout.isTTY;
  const stderrTTY = process.stderr.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    setVerbose(false);
    promptMocks.isCancel.mockReturnValue(false);
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: stderrTTY, configurable: true });
  });

  it('only emits verbose logs when verbose mode is enabled', () => {
    verbose('hidden');
    expect(promptMocks.log.info).not.toHaveBeenCalled();

    setVerbose(true);
    verbose('shown');
    expect(promptMocks.log.info).toHaveBeenCalledWith('[debug] shown');
  });

  it('routes spinner errors through clack error logging', () => {
    const handle = spinner('Working');
    handle.error('Failed hard');
    expect(promptMocks.log.error).toHaveBeenCalledWith('Failed hard');
  });

  it('uses the interactive spinner when attached to a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });

    const handle = spinner('Working');
    handle.message('Still working');
    handle.stop('Done');
    handle.error('Failed hard');

    expect(promptMocks.spinner).toHaveBeenCalledTimes(1);
    expect(promptMocks.spinnerStart).toHaveBeenCalledWith('Working');
    expect(promptMocks.spinnerMessage).toHaveBeenCalledWith('Still working');
    expect(promptMocks.spinnerStop).toHaveBeenCalledWith('Done');
    expect(promptMocks.log.error).toHaveBeenCalledWith('Failed hard');
  });

  it('falls back to log-based progress when not attached to a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });

    const handle = spinner('Working');
    handle.message('Still working');
    handle.stop();

    expect(promptMocks.spinner).not.toHaveBeenCalled();
    expect(promptMocks.log.step).toHaveBeenCalledWith('Still working');
  });

  it('proxies logger helper functions to clack and exposes formatting helpers', () => {
    intro('Intro');
    outro('Outro');
    info('Info');
    success('Success');
    warn('Warning');
    error('Error');
    step('Step');
    message('Message');
    cancel('Cancelled');
    note('Body', 'Title');

    promptMocks.isCancel.mockReturnValue(true);

    expect(isCancel(Symbol('cancel'))).toBe(true);
    expect(promptMocks.intro).toHaveBeenCalledWith('Intro');
    expect(promptMocks.outro).toHaveBeenCalledWith('Outro');
    expect(promptMocks.log.info).toHaveBeenCalledWith('Info');
    expect(promptMocks.log.success).toHaveBeenCalledWith('Success');
    expect(promptMocks.log.warn).toHaveBeenCalledWith('Warning');
    expect(promptMocks.log.error).toHaveBeenCalledWith('Error');
    expect(promptMocks.log.step).toHaveBeenCalledWith('Step');
    expect(promptMocks.log.message).toHaveBeenCalledWith('Message');
    expect(promptMocks.cancel).toHaveBeenCalledWith('Cancelled');
    expect(promptMocks.note).toHaveBeenCalledWith('Body', 'Title');
    expect(stripAnsi(formatSuccessText('ok'))).toBe('ok');
    expect(stripAnsi(formatErrorText('nope'))).toBe('nope');
  });
});
