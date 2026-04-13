// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { FurnaceConfig } from '../../types/furnace.js';
import {
  classifyDriftSeverity,
  findOverrideBaseVersionDrift,
  formatOverrideBaseVersionDriftWarning,
} from '../furnace-version-drift.js';

function configWithOverrides(
  overrides: Record<string, { baseVersion: string; type?: 'css-only' | 'full' }>
): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: Object.fromEntries(
      Object.entries(overrides).map(([name, entry]) => [
        name,
        {
          type: entry.type ?? 'full',
          description: '',
          basePath: `toolkit/content/widgets/${name}`,
          baseVersion: entry.baseVersion,
        },
      ])
    ),
    custom: {},
  };
}

describe('findOverrideBaseVersionDrift', () => {
  it('returns an empty array when every override is in sync', () => {
    const config = configWithOverrides({
      'moz-button': { baseVersion: '145.0' },
      'moz-card': { baseVersion: '145.0' },
    });

    expect(findOverrideBaseVersionDrift(config, '145.0')).toEqual([]);
  });

  it('flags overrides whose baseVersion differs from the current version', () => {
    const config = configWithOverrides({
      'moz-button': { baseVersion: '146.0esr' },
      'moz-card': { baseVersion: '145.0' },
    });

    const drift = findOverrideBaseVersionDrift(config, '145.0');
    expect(drift).toEqual([
      { name: 'moz-button', baseVersion: '146.0esr', currentVersion: '145.0', severity: 'major' },
    ]);
  });

  it('treats any string mismatch as drift, including patch-level divergence', () => {
    const config = configWithOverrides({
      'moz-button': { baseVersion: '145.0' },
    });

    expect(findOverrideBaseVersionDrift(config, '145.0esr')).toEqual([
      { name: 'moz-button', baseVersion: '145.0', currentVersion: '145.0esr', severity: 'patch' },
    ]);
  });

  it('returns no drift when currentVersion is empty', () => {
    const config = configWithOverrides({
      'moz-button': { baseVersion: '146.0esr' },
    });

    // An empty current version means fireforge.json is broken; the caller
    // surfaces that separately — the drift helper must not fabricate a
    // warning against an unknown anchor.
    expect(findOverrideBaseVersionDrift(config, '')).toEqual([]);
  });

  it('ignores overrides whose baseVersion is empty', () => {
    const config = configWithOverrides({
      'moz-button': { baseVersion: '' },
    });

    expect(findOverrideBaseVersionDrift(config, '145.0')).toEqual([]);
  });

  it('returns an empty array when the config has no overrides', () => {
    const config: FurnaceConfig = {
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    };

    expect(findOverrideBaseVersionDrift(config, '145.0')).toEqual([]);
  });
});

describe('formatOverrideBaseVersionDriftWarning', () => {
  it('mentions both versions, component name, and severity', () => {
    const message = formatOverrideBaseVersionDriftWarning({
      name: 'moz-button',
      baseVersion: '146.0esr',
      currentVersion: '145.0',
      severity: 'major',
    });

    expect(message).toContain('moz-button');
    expect(message).toContain('146.0esr');
    expect(message).toContain('145.0');
    expect(message).toContain('major version jump');
    expect(message).toContain('furnace validate');
  });

  it('includes minor label for minor drift', () => {
    const message = formatOverrideBaseVersionDriftWarning({
      name: 'moz-card',
      baseVersion: '145.0',
      currentVersion: '145.1',
      severity: 'minor',
    });
    expect(message).toContain('minor version change');
  });

  it('includes patch label for patch drift', () => {
    const message = formatOverrideBaseVersionDriftWarning({
      name: 'moz-card',
      baseVersion: '145.0.1',
      currentVersion: '145.0.2',
      severity: 'patch',
    });
    expect(message).toContain('patch-level change');
  });
});

describe('classifyDriftSeverity', () => {
  it('returns major when major versions differ', () => {
    expect(classifyDriftSeverity('140.0', '145.0')).toBe('major');
  });

  it('returns minor when only minor versions differ', () => {
    expect(classifyDriftSeverity('145.0', '145.1')).toBe('minor');
  });

  it('returns patch when only patch versions differ', () => {
    expect(classifyDriftSeverity('145.0.1', '145.0.2')).toBe('patch');
  });

  it('returns patch when versions differ only by suffix (e.g. esr)', () => {
    // "145.0" and "145.0esr" have same numeric components
    expect(classifyDriftSeverity('145.0', '145.0esr')).toBe('patch');
  });

  it('returns major for unparseable base version', () => {
    expect(classifyDriftSeverity('unknown', '145.0')).toBe('major');
  });

  it('returns major for unparseable current version', () => {
    expect(classifyDriftSeverity('145.0', 'unknown')).toBe('major');
  });
});
