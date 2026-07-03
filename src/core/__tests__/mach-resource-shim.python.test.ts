// SPDX-License-Identifier: EUPL-1.2
/**
 * Runtime regression tests for the generated Python guard (downstream
 * report, 0.34.0 cycle): with a degraded host, the wrapped psutil calls
 * must return readings that survive mozsystemmonitor's subscripting,
 * iteration/unpacking, len(), `_fields`, and `_asdict()` — the pre-fix
 * `_DegradedReading` only survived attribute access and crashed the
 * fallback itself (`'_DegradedReading' object is not subscriptable` /
 * `... is not iterable`).
 *
 * Unlike the string-matching tests in mach.test.ts, these execute
 * GUARD_PYTHON_SOURCE with python3 against a fake degraded psutil, covering
 * both fallback shapes: the zeroed real-namedtuple path (result classes
 * resolvable from psutil._psplatform/_common) and the `_DegradedReading`
 * duck-type path (classes absent). Skipped when python3 is not on PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { GUARD_PYTHON_SOURCE } from '../mach-resource-shim.js';

const DEGRADED_RAISE =
  'raise RuntimeError("host_statistics64(HOST_VM_INFO64) syscall failed: (ipc/mig) array not large enough")';

/** Fake degraded psutil whose result namedtuples ARE resolvable. */
const FAKE_PSUTIL_WITH_RESULT_CLASSES = `
from collections import namedtuple

svmem = namedtuple("svmem", ["total", "available", "percent", "used", "free", "active", "inactive", "wired"])
sswap = namedtuple("sswap", ["total", "used", "free", "percent", "sin", "sout"])
scputimes = namedtuple("scputimes", ["user", "nice", "system", "idle"])
sdiskio = namedtuple("sdiskio", ["read_count", "write_count", "read_bytes", "write_bytes", "read_time", "write_time"])


class _common(object):
    svmem = svmem
    sswap = sswap
    scputimes = scputimes
    sdiskio = sdiskio


_psplatform = _common


def virtual_memory():
    ${DEGRADED_RAISE}


def swap_memory():
    ${DEGRADED_RAISE}


def cpu_percent(interval=None, percpu=False):
    ${DEGRADED_RAISE}


def cpu_times(percpu=False):
    ${DEGRADED_RAISE}


def disk_io_counters(perdisk=False):
    ${DEGRADED_RAISE}
`;

/** Fake degraded psutil WITHOUT resolvable result classes (duck-type path). */
const FAKE_PSUTIL_WITHOUT_RESULT_CLASSES = `
def virtual_memory():
    ${DEGRADED_RAISE}


def swap_memory():
    ${DEGRADED_RAISE}


def cpu_percent(interval=None, percpu=False):
    ${DEGRADED_RAISE}


def cpu_times(percpu=False):
    ${DEGRADED_RAISE}


def disk_io_counters(perdisk=False):
    ${DEGRADED_RAISE}
`;

/**
 * Exercises the guarded psutil the way mozsystemmonitor does: `_build_meta`
 * subscripts `virtual_memory()[0]`; `_collect` iterates/unpacks readings.
 * Prints a JSON report for the vitest assertions.
 */
const HARNESS_PYTHON = `
import json
import warnings

warnings.simplefilter("ignore")

import fireforge_mach_guard  # noqa: F401  (installs the guard)
import psutil

r = psutil.virtual_memory()


def build_meta():
    # mozsystemmonitor _build_meta style: subscript the reading.
    return {"system_memory": psutil.virtual_memory()[0]}


def collect():
    # mozsystemmonitor _collect style: iterate/unpack readings.
    vm = psutil.virtual_memory()
    total, available = vm[0], vm[1]
    return list(vm) + list(psutil.swap_memory()) + list(psutil.cpu_times()) + [total, available]


meta = build_meta()
collected = collect()
cp = psutil.cpu_percent()

print(json.dumps({
    "type": type(r).__name__,
    "first": r[0],
    "listed": list(r),
    "length": len(r),
    "fields": list(r._fields),
    "percent": r.percent,
    "asdict": r._asdict(),
    "meta": meta,
    "collected_ok": all(v == 0 for v in collected),
    "cpu_percent": cp,
    "cpu_percent_is_float": isinstance(cp, float),
    "disk_len": len(psutil.disk_io_counters()),
}))
`;

interface GuardHarnessReport {
  type: string;
  first: number;
  listed: number[];
  length: number;
  fields: string[];
  percent: number;
  asdict: Record<string, number>;
  meta: { system_memory: number };
  collected_ok: boolean;
  cpu_percent: number;
  cpu_percent_is_float: boolean;
  disk_len: number;
}

const pythonAvailable = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

const tempDirs: string[] = [];

async function runGuardHarness(fakePsutilSource: string): Promise<GuardHarnessReport> {
  const dir = await mkdtemp(join(tmpdir(), 'fireforge-shim-test-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'psutil.py'), fakePsutilSource);
  await writeFile(join(dir, 'fireforge_mach_guard.py'), GUARD_PYTHON_SOURCE);
  await writeFile(join(dir, 'harness.py'), HARNESS_PYTHON);
  const run = spawnSync('python3', ['harness.py'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) {
    throw new Error(`guard harness failed (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as GuardHarnessReport;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!pythonAvailable)('mach resource guard degraded fallbacks (python3)', () => {
  it('degrades to a zeroed real psutil namedtuple when result classes resolve', async () => {
    const report = await runGuardHarness(FAKE_PSUTIL_WITH_RESULT_CLASSES);
    expect(report.type).toBe('svmem');
    expect(report.first).toBe(0);
    expect(report.length).toBe(8);
    expect(report.listed).toEqual(Array<number>(8).fill(0));
    expect(report.fields).toEqual([
      'total',
      'available',
      'percent',
      'used',
      'free',
      'active',
      'inactive',
      'wired',
    ]);
    expect(report.percent).toBe(0);
    expect(report.asdict['total']).toBe(0);
    // mozsystemmonitor-style _build_meta (subscript) and _collect
    // (iterate/unpack) completed without raising.
    expect(report.meta.system_memory).toBe(0);
    expect(report.collected_ok).toBe(true);
    expect(report.cpu_percent_is_float).toBe(true);
    expect(report.cpu_percent).toBe(0);
    // disk_io_counters degrades to a zeroed struct (deliberate over None).
    expect(report.disk_len).toBeGreaterThan(0);
  });

  it('degrades to the _DegradedReading duck type when result classes are absent', async () => {
    const report = await runGuardHarness(FAKE_PSUTIL_WITHOUT_RESULT_CLASSES);
    expect(report.type).toBe('_DegradedReading');
    expect(report.first).toBe(0);
    expect(report.length).toBe(8);
    expect(report.listed).toEqual(Array<number>(8).fill(0));
    expect(report.fields).toEqual([
      'total',
      'available',
      'percent',
      'used',
      'free',
      'active',
      'inactive',
      'wired',
    ]);
    expect(report.percent).toBe(0);
    expect(report.asdict['wired']).toBe(0);
    expect(report.meta.system_memory).toBe(0);
    expect(report.collected_ok).toBe(true);
    expect(report.cpu_percent_is_float).toBe(true);
    expect(report.cpu_percent).toBe(0);
    expect(report.disk_len).toBe(8);
  });
});
