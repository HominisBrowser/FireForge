// SPDX-License-Identifier: EUPL-1.2
import { stripVTControlCharacters } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import * as log from './log.js';

const strip = stripVTControlCharacters;

describe('log', () => {
  let previous: log.LogConfig | undefined;
  afterEach(() => {
    if (previous !== undefined) log.configureLog(previous);
    previous = undefined;
  });

  function capture(config: Omit<log.LogConfig, 'write'> = {}): string[] {
    const lines: string[] = [];
    previous = log.configureLog({ ...config, write: (text) => lines.push(strip(text)) });
    return lines;
  }

  it('writes every level through the configured sink with its prefix', () => {
    const lines = capture({ verbose: true });
    log.info('plain');
    log.step('working');
    log.success('done');
    log.warn('careful');
    log.error('broken');
    log.verbose('detail');
    expect(lines).toEqual([
      'plain\n',
      '> working\n',
      'ok done\n',
      'warning: careful\n',
      'error: broken\n',
      'debug: detail\n',
    ]);
  });

  it('reports a failure as error[code] and its hint, also when quiet', () => {
    const lines = capture({ quiet: true });
    log.failure('lock-timeout', 'The engine is busy.', 'Run it again later.');
    log.failure('internal', 'No hint here.');
    expect(lines).toEqual([
      'error[lock-timeout]: The engine is busy.\n',
      'hint: Run it again later.\n',
      'error[internal]: No hint here.\n',
    ]);
  });

  it('hides verbose lines by default', () => {
    const lines = capture();
    log.verbose('detail');
    expect(lines).toEqual([]);
    expect(log.isVerbose()).toBe(false);
  });

  it('keeps warnings and errors when quiet', () => {
    const lines = capture({ quiet: true });
    log.info('plain');
    log.step('working');
    log.warn('careful');
    log.error('broken');
    expect(lines).toEqual(['warning: careful\n', 'error: broken\n']);
  });

  it('renders a spinner as plain lines when output is captured', () => {
    const lines = capture();
    const spinner = log.spinner('Downloading');
    spinner.update('Extracting');
    spinner.stop('Ready');
    const failed = log.spinner('Building');
    failed.fail('Build failed');
    expect(lines).toEqual([
      '> Downloading\n',
      '> Extracting\n',
      'ok Ready\n',
      '> Building\n',
      'error: Build failed\n',
    ]);
  });
});
