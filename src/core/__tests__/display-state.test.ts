// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { parseDisplayPowerState, probeDisplaySleepState } from '../display-state.js';

describe('parseDisplayPowerState', () => {
  it('reads a lit display as awake', () => {
    expect(
      parseDisplayPowerState(
        ['Current power states:', '  IODisplayWrangler             4       12    -1'].join('\n')
      )
    ).toBe('awake');
  });

  it('reads a dimmed or dark display as asleep', () => {
    for (const state of ['0', '1', '2', '3']) {
      expect(
        parseDisplayPowerState(
          ['Current power states:', `  IODisplayWrangler             ${state}       12    -1`].join(
            '\n'
          )
        )
      ).toBe('asleep');
    }
  });

  it('reports unknown rather than guessing when the row is absent', () => {
    expect(parseDisplayPowerState('Current power states:\n  IOPMrootDomain  4')).toBe('unknown');
    expect(parseDisplayPowerState('')).toBe('unknown');
  });

  it('reports unknown when the row carries no numeric state', () => {
    expect(parseDisplayPowerState('  IODisplayWrangler   (unavailable)')).toBe('unknown');
  });
});

describe('probeDisplaySleepState', () => {
  it('never spawns a probe off darwin', async () => {
    await expect(probeDisplaySleepState('linux')).resolves.toBe('unknown');
    await expect(probeDisplaySleepState('win32')).resolves.toBe('unknown');
  });
});
