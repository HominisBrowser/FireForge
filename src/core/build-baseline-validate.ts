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

function isCoverageAnchor(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value['engineHeadSha'] === 'string' &&
    isFingerprint(value['mozconfigHash']) &&
    isFingerprintMap(value['fingerprints'])
  );
}

/** A `controlBuild` stamp: the control's diff file, its targets and when it went in. */
function isControlBuildStamp(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value['diffFile'] === 'string' &&
    Array.isArray(value['targets']) &&
    value['targets'].every(isBaselinePath) &&
    typeof value['appliedAt'] === 'string' &&
    Number.isFinite(Date.parse(value['appliedAt']))
  );
}

/** A `recorder` stamp: an integer pid, an invocation id and an optional session id. */
function isBaselineRecorder(value: unknown): boolean {
  return (
    isObject(value) &&
    Number.isInteger(value['pid']) &&
    typeof value['invocationId'] === 'string' &&
    (value['sessionId'] === undefined || typeof value['sessionId'] === 'string')
  );
}

/**
 * The first field of a persisted baseline that fails validation, and the
 * offending value: what a refusal names so the operator can tell a scoped
 * coverage claim from a corrupt marker.
 */
export interface BuildBaselineProblem {
  /** Field path, e.g. `testPackagingCoverage[2]` or `testCoverageRecords["a/"]`. */
  field: string;
  /** The offending value, as found (may be any JSON value). */
  value: unknown;
}

/** Fields whose problem a scoped `test --build` can leave and a fresh one replaces. */
const COVERAGE_FIELDS = ['testPackagingCoverage', 'testCoverageRecords', 'fullCoverageAnchor'];

/** True when the problem sits in a packaging-coverage field. */
export function isCoverageProblem(problem: BuildBaselineProblem): boolean {
  return COVERAGE_FIELDS.some(
    (field) =>
      problem.field === field ||
      problem.field.startsWith(`${field}[`) ||
      problem.field.startsWith(`${field}.`)
  );
}

/** Renders a problem for a refusal: the field and a bounded JSON rendering of its value. */
export function describeBuildBaselineProblem(problem: BuildBaselineProblem): string {
  let rendered: string;
  try {
    // JSON.stringify(undefined) returns undefined at runtime despite its type.
    const json = JSON.stringify(problem.value) as string | undefined;
    rendered = json ?? 'undefined';
  } catch {
    rendered = String(problem.value);
  }
  if (rendered.length > 120) rendered = `${rendered.slice(0, 117)}...`;
  return `${problem.field} = ${rendered}`;
}

function findFingerprintMapProblem(
  field: string,
  value: unknown
): BuildBaselineProblem | undefined {
  if (!isObject(value)) return { field, value };
  for (const [path, fingerprint] of Object.entries(value)) {
    if (!isBaselinePath(path)) return { field: `${field}[${JSON.stringify(path)}]`, value: path };
    if (!isFingerprint(fingerprint)) {
      return { field: `${field}[${JSON.stringify(path)}]`, value: fingerprint };
    }
  }
  return undefined;
}

function findCoverageRecordProblem(value: unknown): BuildBaselineProblem | undefined {
  const field = 'testCoverageRecords';
  if (!isObject(value)) return { field, value };
  for (const [path, record] of Object.entries(value)) {
    const entry = `${field}[${JSON.stringify(path)}]`;
    if (!isBaselinePath(path)) return { field: entry, value: path };
    if (!isCoverageAnchor(record) || !isObject(record) || !Array.isArray(record['inputs'])) {
      return { field: entry, value: record };
    }
    const inputs: unknown[] = record['inputs'];
    const input = inputs.find((item) => !isBaselinePath(item));
    if (input !== undefined) return { field: `${entry}.inputs`, value: input };
  }
  return undefined;
}

/**
 * Validates persisted fields without converting malformed coverage into a
 * full claim, and returns the first failing field with its value, or
 * undefined when the baseline is valid.
 *
 * @param value - The parsed `last-build.json`
 */
export function findBuildBaselineProblem(value: unknown): BuildBaselineProblem | undefined {
  if (!isObject(value)) return { field: '(root)', value };
  if (typeof value['engineHeadSha'] !== 'string') {
    return { field: 'engineHeadSha', value: value['engineHeadSha'] };
  }
  if (typeof value['builtAt'] !== 'string' || !Number.isFinite(Date.parse(value['builtAt']))) {
    return { field: 'builtAt', value: value['builtAt'] };
  }
  if (typeof value['binaryName'] !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value['binaryName'])) {
    return { field: 'binaryName', value: value['binaryName'] };
  }
  for (const field of [
    'packageableFingerprints',
    'testInputFingerprints',
    'buildInputFingerprints',
  ]) {
    if (value[field] === undefined) continue;
    const problem = findFingerprintMapProblem(field, value[field]);
    if (problem !== undefined) return problem;
  }
  const coverage = value['testPackagingCoverage'];
  if (coverage !== undefined && coverage !== 'full') {
    if (!Array.isArray(coverage)) return { field: 'testPackagingCoverage', value: coverage };
    const index = coverage.findIndex((path) => !isBaselinePath(path));
    if (index >= 0) {
      return { field: `testPackagingCoverage[${index}]`, value: coverage[index] };
    }
  }
  if (value['mozconfigHash'] !== undefined && !isFingerprint(value['mozconfigHash'])) {
    return { field: 'mozconfigHash', value: value['mozconfigHash'] };
  }
  if (value['recordedBy'] !== undefined && typeof value['recordedBy'] !== 'string') {
    return { field: 'recordedBy', value: value['recordedBy'] };
  }
  if (value['recorder'] !== undefined && !isBaselineRecorder(value['recorder'])) {
    return { field: 'recorder', value: value['recorder'] };
  }
  if (value['testCoverageRecords'] !== undefined) {
    const problem = findCoverageRecordProblem(value['testCoverageRecords']);
    if (problem !== undefined) return problem;
  }
  if (value['fullCoverageAnchor'] !== undefined && !isCoverageAnchor(value['fullCoverageAnchor'])) {
    return { field: 'fullCoverageAnchor', value: value['fullCoverageAnchor'] };
  }
  const components = value['staticComponentsBaseline'];
  if (
    components !== undefined &&
    !(
      isObject(components) &&
      typeof components['engineHeadSha'] === 'string' &&
      isFingerprintMap(components['fingerprints'])
    )
  ) {
    return { field: 'staticComponentsBaseline', value: components };
  }
  if (value['controlBuild'] !== undefined && !isControlBuildStamp(value['controlBuild'])) {
    return { field: 'controlBuild', value: value['controlBuild'] };
  }
  return undefined;
}

/**
 * Validates persisted fields without converting malformed coverage into a
 * full claim. The boolean form of {@link findBuildBaselineProblem}.
 *
 * @internal Exported only so tests can reach it. Production reads go
 * through `findBuildBaselineProblem`, which names the failing field.
 */
export function isBuildBaseline(value: unknown): value is BuildBaseline {
  return findBuildBaselineProblem(value) === undefined;
}
