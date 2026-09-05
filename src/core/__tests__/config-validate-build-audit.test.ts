// SPDX-License-Identifier: EUPL-1.2
/**
 * `buildAudit.unpackaged` validation.
 *
 * Every entry is a standing suppression of a warning the packaging audit
 * would otherwise raise, so a malformed one has to fail at config load. The
 * two failure modes that matter are silently admitting nothing (the
 * operator believes a path is carved out and it is not) and silently
 * admitting everything (a reviewed exception becomes a blanket one).
 */
import { describe, expect, it } from 'vitest';

import { parseBuildAuditConfig } from '../config-validate-build-audit.js';

const VALID = { path: 'browser/base/content/types.js', reason: 'Type-only mirror; never loaded.' };

describe('parseBuildAuditConfig', () => {
  it('accepts a well-formed carve-out', () => {
    expect(parseBuildAuditConfig({ unpackaged: [VALID] })).toEqual({ unpackaged: [VALID] });
  });

  it('accepts a glob within one path segment', () => {
    const entry = { path: 'browser/base/content/*-types.js', reason: 'Type-only mirrors.' };
    expect(parseBuildAuditConfig({ unpackaged: [entry] })).toEqual({ unpackaged: [entry] });
  });

  it('accepts an absent unpackaged list', () => {
    expect(parseBuildAuditConfig({})).toEqual({});
  });

  it('requires a non-empty reason', () => {
    // This is the one audit class FireForge cannot derive from the tree, so
    // the declaration is the evidence, and an unexplained one is a mistake
    // by the time anyone reads it.
    expect(() => parseBuildAuditConfig({ unpackaged: [{ path: 'a/b.js' }] })).toThrow(/reason/);
    expect(() => parseBuildAuditConfig({ unpackaged: [{ path: 'a/b.js', reason: '  ' }] })).toThrow(
      /reason/
    );
  });

  it('requires a non-empty engine-relative path', () => {
    expect(() => parseBuildAuditConfig({ unpackaged: [{ path: '', reason: 'x' }] })).toThrow(
      /path/
    );
    expect(() =>
      parseBuildAuditConfig({ unpackaged: [{ path: '../escape.js', reason: 'x' }] })
    ).toThrow(/engine-relative/);
  });

  it('refuses a ** carve-out', () => {
    // A subtree carve-out is how a reviewed exception quietly becomes a
    // blanket one.
    expect(() =>
      parseBuildAuditConfig({ unpackaged: [{ path: 'browser/**/*.js', reason: 'x' }] })
    ).toThrow(/must not use/);
  });

  it('refuses a duplicate path', () => {
    // Two rows for one path means one of the reasons is not operative and
    // nothing says which.
    expect(() => parseBuildAuditConfig({ unpackaged: [VALID, VALID] })).toThrow(/more than once/);
  });

  it('refuses unknown keys at both levels', () => {
    expect(() => parseBuildAuditConfig({ unknown: [] })).toThrow(/unknown key/);
    expect(() => parseBuildAuditConfig({ unpackaged: [{ ...VALID, severity: 'off' }] })).toThrow(
      /unknown key/
    );
  });

  it('refuses non-object and non-array shapes', () => {
    expect(() => parseBuildAuditConfig('nope')).toThrow(/plain object/);
    expect(() => parseBuildAuditConfig({ unpackaged: 'a/b.js' })).toThrow(/must be an array/);
    expect(() => parseBuildAuditConfig({ unpackaged: ['a/b.js'] })).toThrow(/plain object/);
  });
});
