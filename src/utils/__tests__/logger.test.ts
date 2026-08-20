// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() })),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

import * as clack from '@clack/prompts';

import {
  cancel,
  error,
  formatErrorText,
  formatSuccessText,
  info,
  intro,
  isCancel,
  isMachineOutputMode,
  message,
  note,
  notice,
  NOTICE_PREFIX,
  outro,
  setMachineOutputMode,
  setStdoutSealed,
  setVerbose,
  spinner,
  step,
  success,
  verbose,
  warn,
} from '../logger.js';

describe('logger machine-output mode', () => {
  let stderrLines: string[];
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    setMachineOutputMode(true);
  });

  afterEach(() => {
    setMachineOutputMode(false);
    setVerbose(false);
    stderrSpy.mockRestore();
  });

  it('routes every diagnostic to stderr and none to clack (stdout)', () => {
    info('info line');
    success('success line');
    warn('warn line');
    error('error line');
    step('step line');
    message('message line');
    note('note body', 'Title');
    cancel('cancelled op');

    expect(stderrLines).toEqual([
      'info line\n',
      'success line\n',
      'warning: warn line\n',
      'error: error line\n',
      'step line\n',
      'message line\n',
      'Title: note body\n',
      'cancelled: cancelled op\n',
    ]);
    // Nothing may touch clack's stdout-bound log helpers: a warning before
    // the JSON body used to break every `status --json | jq` consumer.
    expect(clack.log.info).not.toHaveBeenCalled();
    expect(clack.log.warn).not.toHaveBeenCalled();
    expect(clack.log.error).not.toHaveBeenCalled();
    expect(clack.cancel).not.toHaveBeenCalled();
    expect(clack.note).not.toHaveBeenCalled();
  });

  it('suppresses intro/outro banners entirely', () => {
    intro('FireForge Status');
    outro('Done');

    expect(stderrLines).toEqual([]);
    expect(clack.intro).not.toHaveBeenCalled();
    expect(clack.outro).not.toHaveBeenCalled();
  });

  it('emits verbose diagnostics to stderr when verbose is on', () => {
    verbose('hidden');
    expect(stderrLines).toEqual([]);

    setVerbose(true);
    verbose('shown');
    expect(stderrLines).toEqual(['[debug] shown\n']);
  });

  it('spinners degrade to stderr progress lines', () => {
    const handle = spinner('working...');
    handle.message('halfway');
    handle.stop('done');
    handle.error('boom');

    expect(clack.spinner).not.toHaveBeenCalled();
    expect(stderrLines).toEqual(['halfway\n', 'done\n', 'error: boom\n']);
  });

  it('reports the mode through isMachineOutputMode', () => {
    expect(isMachineOutputMode()).toBe(true);
    setMachineOutputMode(false);
    expect(isMachineOutputMode()).toBe(false);
  });
});

describe('logger stdout seal', () => {
  let stderrLines: string[];
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    vi.clearAllMocks();
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    setStdoutSealed(true);
  });

  afterEach(() => {
    setStdoutSealed(false);
    stderrSpy.mockRestore();
  });

  it('routes human output to stderr while sealed, without engaging machine mode', () => {
    expect(isMachineOutputMode()).toBe(false);
    error('post-verdict error');
    info('post-verdict info');
    cancel('post-verdict cancel');

    expect(stderrLines).toEqual([
      'error: post-verdict error\n',
      'post-verdict info\n',
      'cancelled: post-verdict cancel\n',
    ]);
    expect(clack.log.error).not.toHaveBeenCalled();
    expect(clack.log.info).not.toHaveBeenCalled();
    expect(clack.cancel).not.toHaveBeenCalled();
  });

  it('suppresses outro banners while sealed (nothing may follow the verdict on stdout)', () => {
    outro('Test completed');
    expect(stderrLines).toEqual([]);
    expect(clack.outro).not.toHaveBeenCalled();
  });

  it('unsealing restores stdout routing through clack', () => {
    setStdoutSealed(false);
    info('normal again');
    expect(stderrLines).toEqual([]);
    expect(clack.log.info).toHaveBeenCalledWith('normal again');
  });
});

describe('logger human mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMachineOutputMode(false);
  });

  it('delegates to clack helpers', () => {
    info('i');
    success('s');
    warn('w');
    error('e');
    step('st');
    message('m');
    intro('in');
    outro('out');
    note('body', 'title');
    cancel('c');

    expect(clack.log.info).toHaveBeenCalledWith('i');
    expect(clack.log.success).toHaveBeenCalledWith('s');
    expect(clack.log.warn).toHaveBeenCalledWith('w');
    expect(clack.log.error).toHaveBeenCalledWith('e');
    expect(clack.log.step).toHaveBeenCalledWith('st');
    expect(clack.log.message).toHaveBeenCalledWith('m');
    expect(clack.intro).toHaveBeenCalledWith('in');
    expect(clack.outro).toHaveBeenCalledWith('out');
    expect(clack.note).toHaveBeenCalledWith('body', 'title');
    expect(clack.cancel).toHaveBeenCalledWith('c');
  });

  it('verbose only logs when enabled', () => {
    setVerbose(false);
    verbose('quiet');
    expect(clack.log.info).not.toHaveBeenCalled();

    setVerbose(true);
    verbose('loud');
    expect(clack.log.info).toHaveBeenCalledWith('[debug] loud');
    setVerbose(false);
  });

  it('non-interactive spinner falls back to step/error logging', () => {
    // vitest's stdout is not a TTY, so the non-interactive branch runs.
    const handle = spinner('initial');
    handle.message('progress');
    handle.stop();
    handle.error();

    expect(clack.log.step).toHaveBeenCalledWith('progress');
    // stop() without a message re-prints the latest message.
    expect(clack.log.step).toHaveBeenCalledWith('progress');
    expect(clack.log.error).toHaveBeenCalledWith('Failed');
  });
  it('note without a title emits the bare message', () => {
    setMachineOutputMode(true);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      note('untitled body');
      expect(lines).toEqual(['untitled body\n']);
    } finally {
      spy.mockRestore();
      setMachineOutputMode(false);
    }
  });

  it('formatters colorize without logging; isCancel delegates to clack', () => {
    expect(formatSuccessText('ok')).toContain('ok');
    expect(formatErrorText('bad')).toContain('bad');
    expect(isCancel(Symbol('x'))).toBe(false);
    expect(clack.isCancel).toHaveBeenCalled();
  });

  it('interactive spinner drives the clack spinner when both streams are TTYs', () => {
    const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stderrDesc = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    const startMock = vi.fn();
    const messageMock = vi.fn();
    const stopMock = vi.fn();
    vi.mocked(clack.spinner).mockReturnValue({
      start: startMock,
      message: messageMock,
      stop: stopMock,
    } as never);
    try {
      const handle = spinner('initial');
      handle.message('progress');
      handle.stop();
      handle.error('boom');

      expect(startMock).toHaveBeenCalledWith('initial');
      expect(messageMock).toHaveBeenCalledWith('progress');
      expect(stopMock).toHaveBeenCalledWith('initial');
      expect(clack.log.error).toHaveBeenCalledWith('boom');
    } finally {
      if (stdoutDesc) Object.defineProperty(process.stdout, 'isTTY', stdoutDesc);
      if (stderrDesc) Object.defineProperty(process.stderr, 'isTTY', stderrDesc);
    }
  });
});

describe('notice', () => {
  afterEach(() => {
    setMachineOutputMode(false);
    setStdoutSealed(false);
  });

  it('rides the WARNING channel so an agent output filter cannot drop it', () => {
    vi.clearAllMocks();
    notice('escalating this pre-test build to a full mach build');

    // Warning severity is the whole point: filters that keep only
    // warnings and errors were dropping FireForge's own explanations,
    // leaving a multi-minute build unexplained.
    expect(clack.log.warn).toHaveBeenCalledWith(
      `${NOTICE_PREFIX} escalating this pre-test build to a full mach build`
    );
    expect(clack.log.info).not.toHaveBeenCalled();
  });

  it('keeps the warning prefix and the notice marker in machine mode', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    setMachineOutputMode(true);
    try {
      notice('backend regeneration');
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderrLines).toEqual([`warning: ${NOTICE_PREFIX} backend regeneration\n`]);
  });

  it('is distinguishable from a real warning by its prefix', () => {
    vi.clearAllMocks();
    warn('a genuine warning');
    notice('an explanation');

    const calls = vi.mocked(clack.log.warn).mock.calls;
    expect(calls[0]?.[0]).not.toContain(NOTICE_PREFIX);
    expect(calls[1]?.[0]).toContain(NOTICE_PREFIX);
  });
});
