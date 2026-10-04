// SPDX-License-Identifier: EUPL-1.2
import { isObject } from '../utils/validation.js';
import { type BuildBaseline, DELETED_FILE_FINGERPRINT } from './build-baseline-types.js';

/** Baseline paths are engine-relative POSIX identifiers, never filesystem escapes. */
function isBaselinePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function isFingerprint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^[a-f0-9]{64}$/i.test(value) || value === DELETED_FILE_FINGERPRINT)
  );
}

function isFingerprintMap(value: unknown): value is Record<string, string> {
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([path, fingerprint]) => isBaselinePath(path) && isFingerprint(fingerprint)
    )
  );
}

/** Validates persisted fields without converting malformed coverage into a full claim. */
export function isBuildBaseline(value: unknown): value is BuildBaseline {
  if (!isObject(value)) return false;
  if (
    typeof value['engineHeadSha'] !== 'string' ||
    typeof value['builtAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['builtAt'])) ||
    typeof value['binaryName'] !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(value['binaryName'])
  )
    return false;

  for (const field of [
    'packageableFingerprints',
    'testInputFingerprints',
    'buildInputFingerprints',
  ]) {
    if (value[field] !== undefined && !isFingerprintMap(value[field])) return false;
  }
  const coverage = value['testPackagingCoverage'];
  if (
    coverage !== undefined &&
    coverage !== 'full' &&
    !(Array.isArray(coverage) && coverage.every(isBaselinePath))
  )
    return false;
  if (value['mozconfigHash'] !== undefined && !isFingerprint(value['mozconfigHash'])) return false;
  if (value['recordedBy'] !== undefined && typeof value['recordedBy'] !== 'string') return false;
  const components = value['staticComponentsBaseline'];
  return (
    components === undefined ||
    (isObject(components) &&
      typeof components['engineHeadSha'] === 'string' &&
      isFingerprintMap(components['fingerprints']))
  );
}
