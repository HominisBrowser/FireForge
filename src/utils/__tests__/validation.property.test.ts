// SPDX-License-Identifier: EUPL-1.2
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  describePatchNameProblem,
  describeTokenNameProblem,
  inferProductFromVersion,
  isValidAppId,
  isValidFirefoxVersion,
  normalizeTokenName,
} from '../validation.js';

// ---------------------------------------------------------------------------
// Helpers — arbitraries that produce known-valid values
// ---------------------------------------------------------------------------

/** Generates a valid stable/ESR/beta Firefox version string. */
const validFirefoxVersion = fc.oneof(
  // stable: "140.9.0", "140.9.1"
  fc
    .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 99 }))
    .map(([maj, min]) => `${maj}.${min}`),
  fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 })
    )
    .map(([maj, min, patch]) => `${maj}.${min}.${patch}`),
  // ESR: "140.9.0esr", "128.0.1esr"
  fc
    .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 99 }))
    .map(([maj, min]) => `${maj}.${min}esr`),
  fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 })
    )
    .map(([maj, min, patch]) => `${maj}.${min}.${patch}esr`),
  // Beta: "147.0b1"
  fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 1, max: 99 })
    )
    .map(([maj, min, beta]) => `${maj}.${min}b${beta}`)
);

/** Generates a reverse-domain app ID like "org.example.browser". */
const validAppId = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
    fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/), { minLength: 1, maxLength: 4 })
  )
  .map(([first, rest]) => [first, ...rest].join('.'));

/** Generates a valid patch name (letters, numbers, hyphens, underscores, spaces; 1–50 chars). */
const validPatchName = fc
  .stringMatching(/^[a-zA-Z0-9\-_ ]{1,50}$/)
  .filter((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('property: isValidFirefoxVersion', () => {
  it('accepts all generated valid versions', () => {
    fc.assert(
      fc.property(validFirefoxVersion, (version) => {
        expect(isValidFirefoxVersion(version)).toBe(true);
      })
    );
  });

  it('rejects versions with a leading zero major', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (min) => {
        expect(isValidFirefoxVersion(`0.${min}`)).toBe(false);
      })
    );
  });

  it('rejects arbitrary non-version strings', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[1-9]\d{0,2}\.\d+/.test(s)),
        (garbage) => {
          expect(isValidFirefoxVersion(garbage)).toBe(false);
        }
      )
    );
  });
});

describe('property: isValidAppId', () => {
  it('accepts all generated valid reverse-domain IDs', () => {
    fc.assert(
      fc.property(validAppId, (appId) => {
        expect(isValidAppId(appId)).toBe(true);
      })
    );
  });

  it('rejects single-segment identifiers', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/), (segment) => {
        expect(isValidAppId(segment)).toBe(false);
      })
    );
  });

  it('rejects IDs starting with an uppercase letter', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z][a-z0-9]*\.[a-z][a-z0-9]*$/), (id) => {
        expect(isValidAppId(id)).toBe(false);
      })
    );
  });
});

describe('property: inferProductFromVersion', () => {
  it('infers ESR for any version containing "esr"', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 99 }))
          .map(([maj, min]) => `${maj}.${min}esr`),
        (version) => {
          expect(inferProductFromVersion(version)).toBe('firefox-esr');
        }
      )
    );
  });

  it('infers beta for versions with bN suffix', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.integer({ min: 1, max: 999 }),
            fc.integer({ min: 0, max: 99 }),
            fc.integer({ min: 1, max: 99 })
          )
          .map(([maj, min, b]) => `${maj}.${min}b${b}`),
        (version) => {
          expect(inferProductFromVersion(version)).toBe('firefox-beta');
        }
      )
    );
  });

  it('returns undefined for plain stable versions', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 99 }))
          .map(([maj, min]) => `${maj}.${min}`),
        (version) => {
          expect(inferProductFromVersion(version)).toBeUndefined();
        }
      )
    );
  });
});

/** Generates a valid CSS custom property ident (no whitespace, control chars, or CSS-breaking chars). */
const validTokenIdent = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,40}$/)
  .filter((s) => s.length > 0 && s.replace(/^--/, '').length > 0);

describe('property: normalizeTokenName', () => {
  it('is idempotent — normalizing twice gives the same result', () => {
    fc.assert(
      fc.property(validTokenIdent, (name) => {
        const once = normalizeTokenName(name);
        const twice = normalizeTokenName(once);
        expect(twice).toBe(once);
      })
    );
  });

  it('always produces a string starting with --', () => {
    fc.assert(
      fc.property(validTokenIdent, (name) => {
        expect(normalizeTokenName(name).startsWith('--')).toBe(true);
      })
    );
  });

  it('throws on names with whitespace or control characters', () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter((s) => /\s/.test(s.replace(/^--/, '')) && s.replace(/^--/, '').length > 0),
        (name) => {
          expect(() => normalizeTokenName(name)).toThrow();
        }
      )
    );
  });
});

describe('property: describeTokenNameProblem', () => {
  it('accepts all valid CSS-safe idents', () => {
    fc.assert(
      fc.property(validTokenIdent, (name) => {
        expect(describeTokenNameProblem(name)).toBeUndefined();
      })
    );
  });
});

describe('property: describePatchNameProblem', () => {
  it('returns undefined (valid) for all well-formed names', () => {
    fc.assert(
      fc.property(validPatchName, (name) => {
        expect(describePatchNameProblem(name)).toBeUndefined();
      })
    );
  });

  it('rejects names longer than 50 characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9]{51,100}$/), (name) => {
        expect(describePatchNameProblem(name)).toBe('Name must be 50 characters or less');
      })
    );
  });

  it('rejects empty and whitespace-only names', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ \t]*$/).filter((s) => s.length <= 50),
        (name) => {
          expect(describePatchNameProblem(name)).toBe('Name is required');
        }
      )
    );
  });
});
