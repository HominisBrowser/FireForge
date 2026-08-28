// SPDX-License-Identifier: EUPL-1.2
/**
 * Runtime regression tests for the generated Python guard: on a degraded
 * host the wrapped psutil calls must return readings that survive
 * mozsystemmonitor's subscripting, iteration/unpacking, len(), `_fields`,
 * and `_asdict()` — and be per-function arity-correct, picklable across the
 * collector pipe, and reconstructible via `type(reading)(*values)`. The
 * parent rebuilds each collector sample with `self._swap_type(*swap_mem)`,
 * so an svmem-shaped (8-field) fallback in the swap (6-field sswap) position
 * rejects every sample, fills the pipe, blocks the collector child in
 * send(), and wedges mach's atexit join forever.
 *
 * Unlike the string-matching tests in mach.test.ts, these execute
 * GUARD_PYTHON_SOURCE with python3 against fake psutil/monitor modules,
 * covering both fallback shapes (psutil's own result classes resolvable, or
 * absent → the guard's module-level per-function namedtuples), collector
 * suppression on a degraded host, and the mozbuild BuildMonitor
 * `log_resource_usage` wrap. Skipped when python3 is not on PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** Fake degraded psutil WITHOUT resolvable result classes (guard-owned fallback path). */
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
 * Fake FLAPPING psutil for the monitor harness: healthy until the harness
 * flips `_state["fail"]`, mimicking a host whose vm/swap syscalls flap
 * between working and degraded.
 */
const FAKE_PSUTIL_FLAPPING = `
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

_state = {"fail": False}


def _maybe_fail():
    if _state["fail"]:
        ${DEGRADED_RAISE}


def virtual_memory():
    _maybe_fail()
    return svmem(8, 7, 6.0, 5, 4, 3, 2, 1)


def swap_memory():
    _maybe_fail()
    return sswap(6, 5, 4, 3.0, 2, 1)


def cpu_percent(interval=None, percpu=False):
    _maybe_fail()
    return [1.0] if percpu else 1.0


def cpu_times(percpu=False):
    _maybe_fail()
    return [scputimes(1, 2, 3, 4)] if percpu else scputimes(1, 2, 3, 4)


def disk_io_counters(perdisk=False):
    _maybe_fail()
    return sdiskio(1, 2, 3, 4, 5, 6)
`;

/**
 * Stub mozsystemmonitor.resourcemonitor: records which orig methods run and
 * carries the upstream-named `_process`/`_pipe` attributes so the guard's
 * collector suppression can be observed without real multiprocessing.
 */
const FAKE_RESOURCEMONITOR = `
class StubProcess(object):
    def __init__(self):
        self.alive = True
        self.terminated = False
        self.joined = False

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.terminated = True
        self.alive = False

    def join(self, timeout=None):
        self.joined = True


class StubPipe(object):
    def __init__(self):
        self.items = ["sample1", "sample2"]

    def poll(self, timeout=None):
        return bool(self.items)

    def recv(self):
        return self.items.pop(0)


class SystemResourceMonitor(object):
    def __init__(self, poll_interval=1.0):
        self.poll_interval = poll_interval
        self._process = StubProcess()
        self._pipe = StubPipe()
        self.start_calls = 0
        self.stop_calls = 0

    def start(self):
        self.start_calls += 1

    def stop(self):
        self.stop_calls += 1

    def aggregate_io(self, phase=None):
        raise RuntimeError("aggregation raced a degraded reading")

    def aggregate_cpu_percent(self, start=None, end=None, phase=None, per_cpu=True):
        return "orig-cpu-percent"

    def aggregate_cpu_times(self, start=None, end=None, phase=None, per_cpu=True):
        return "orig-cpu-times"
`;

/**
 * Stub mozbuild.controller.building.BuildMonitor whose log_resource_usage
 * raises the AttributeError (usage["io"] is None → .read_bytes) —
 * post-compile resource reporting must warn-and-continue, not fail a build
 * whose artifacts are complete.
 */
const FAKE_BUILDING = `
class BuildMonitor(object):
    def log_resource_usage(self, usage):
        raise AttributeError("'NoneType' object has no attribute 'read_bytes'")
`;

/**
 * Exercises the guarded psutil the way mozsystemmonitor does: `_build_meta`
 * subscripts `virtual_memory()[0]`; `_collect` iterates/unpacks readings
 * (per-CPU) and the parent reconstructs each pickled sample via
 * `type(reading)(*values)`. Prints a JSON report for the vitest assertions.
 */
const HARNESS_PYTHON = `
import json
import pickle
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


def parent_rebuild_ok(reading):
    # mozsystemmonitor parent style: self._swap_type(*swap_mem) — the
    # captured type must reconstruct from the sample's values.
    rebuilt = type(reading)(*list(reading))
    return len(rebuilt) == len(reading)


def pipe_pickle_ok(reading):
    # Readings cross the collector pipe via pickle (by reference).
    clone = pickle.loads(pickle.dumps(reading))
    return list(clone) == list(reading)


meta = build_meta()
collected = collect()
cp = psutil.cpu_percent()
swap = psutil.swap_memory()
cpu_times = psutil.cpu_times()
disk = psutil.disk_io_counters()

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
    "cpu_percent_percpu": psutil.cpu_percent(percpu=True),
    "cpu_times_percpu": psutil.cpu_times(percpu=True),
    "swap_fields": list(swap._fields),
    "swap_len": len(swap),
    "swap_zeroed": all(v == 0 for v in swap),
    "cpu_times_len": len(cpu_times),
    "disk_fields": list(disk._fields),
    "disk_len": len(disk),
    "rebuild_ok": all(parent_rebuild_ok(x) for x in (r, swap, cpu_times, disk)),
    "pickle_ok": all(pipe_pickle_ok(x) for x in (r, swap, cpu_times, disk)),
}))
`;

/**
 * Exercises collector suppression and the BuildMonitor wrap on a flapping
 * host: a monitor degrading mid-run must terminate/drain its collector and
 * return zeroed aggregate shapes; once the host has degraded, new monitors
 * must never start a collector; log_resource_usage must warn-and-continue.
 */
const MONITOR_HARNESS_PYTHON = `
import json
import warnings

import fireforge_mach_guard  # noqa: F401  (installs the guard + import hook)
import psutil

import mozsystemmonitor.resourcemonitor as rm
import mozbuild.controller.building as building

report = {}

# Scenario B: healthy at init, degrades mid-run on a raising aggregate.
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    b = rm.SystemResourceMonitor(poll_interval=0.1)
    b.start()
    report["b_start_calls"] = b.start_calls
    io = b.aggregate_io()
    report["b_io_len"] = len(io)
    report["b_io_read_bytes"] = io.read_bytes
    report["b_io_zeroed"] = all(v == 0 for v in io)
    report["b_process_terminated"] = b._process.terminated
    report["b_process_joined"] = b._process.joined
    report["b_pipe_drained"] = len(b._pipe.items) == 0
    report["b_cpu_percent_scalar"] = b.aggregate_cpu_percent(per_cpu=False)
    report["b_cpu_percent_percpu"] = b.aggregate_cpu_percent()
    report["b_cpu_times_len"] = len(b.aggregate_cpu_times(per_cpu=False))
    b.stop()
    report["b_stop_calls"] = b.stop_calls

    # Host flag is now set (the aggregate_io raise degraded the process).
    # Scenario A: a fresh monitor on a degraded host stays inert.
    a = rm.SystemResourceMonitor(poll_interval=0.1)
    a.start()
    report["a_start_calls"] = a.start_calls
    report["a_process_terminated"] = a._process.terminated
    a_io = a.aggregate_io()
    report["a_io_len"] = len(a_io)
    report["a_io_read_bytes"] = a_io.read_bytes

    # Flapping psutil: a degraded reading keeps the correct per-function
    # shape so the parent's type-capture reconstruction survives either
    # flapping direction.
    psutil._state["fail"] = True
    degraded_swap = psutil.swap_memory()
    report["degraded_swap_len"] = len(degraded_swap)
    psutil._state["fail"] = False
    healthy_swap = psutil.swap_memory()
    report["rebuild_across_flap_ok"] = (
        len(type(degraded_swap)(*list(healthy_swap))) == 6
        and len(type(healthy_swap)(*list(degraded_swap))) == 6
    )

# BuildMonitor: post-compile resource logging must warn, not raise.
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    bm = building.BuildMonitor()
    result = bm.log_resource_usage({"io": None})
    report["bm_result_is_none"] = result is None
    report["bm_warned"] = any("resource monitor degraded" in str(w.message) for w in caught)

print(json.dumps(report))
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
  cpu_percent_percpu: number[];
  cpu_times_percpu: number[];
  swap_fields: string[];
  swap_len: number;
  swap_zeroed: boolean;
  cpu_times_len: number;
  disk_fields: string[];
  disk_len: number;
  rebuild_ok: boolean;
  pickle_ok: boolean;
}

interface MonitorHarnessReport {
  b_start_calls: number;
  b_io_len: number;
  b_io_read_bytes: number;
  b_io_zeroed: boolean;
  b_process_terminated: boolean;
  b_process_joined: boolean;
  b_pipe_drained: boolean;
  b_cpu_percent_scalar: number;
  b_cpu_percent_percpu: number[];
  b_cpu_times_len: number;
  b_stop_calls: number;
  a_start_calls: number;
  a_process_terminated: boolean;
  a_io_len: number;
  a_io_read_bytes: number;
  degraded_swap_len: number;
  rebuild_across_flap_ok: boolean;
  bm_result_is_none: boolean;
  bm_warned: boolean;
}

const pythonAvailable = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

const tempDirs: string[] = [];

async function makeHarnessDir(fakePsutilSource: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fireforge-shim-test-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'psutil.py'), fakePsutilSource);
  await writeFile(join(dir, 'fireforge_mach_guard.py'), GUARD_PYTHON_SOURCE);
  return dir;
}

function runHarness(dir: string): unknown {
  const run = spawnSync('python3', ['harness.py'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) {
    throw new Error(`guard harness failed (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

async function runGuardHarness(fakePsutilSource: string): Promise<GuardHarnessReport> {
  const dir = await makeHarnessDir(fakePsutilSource);
  await writeFile(join(dir, 'harness.py'), HARNESS_PYTHON);
  return runHarness(dir) as GuardHarnessReport;
}

async function runMonitorHarness(): Promise<MonitorHarnessReport> {
  const dir = await makeHarnessDir(FAKE_PSUTIL_FLAPPING);
  await mkdir(join(dir, 'mozsystemmonitor'));
  await writeFile(join(dir, 'mozsystemmonitor', '__init__.py'), '');
  await writeFile(join(dir, 'mozsystemmonitor', 'resourcemonitor.py'), FAKE_RESOURCEMONITOR);
  await mkdir(join(dir, 'mozbuild', 'controller'), { recursive: true });
  await writeFile(join(dir, 'mozbuild', '__init__.py'), '');
  await writeFile(join(dir, 'mozbuild', 'controller', '__init__.py'), '');
  await writeFile(join(dir, 'mozbuild', 'controller', 'building.py'), FAKE_BUILDING);
  await writeFile(join(dir, 'harness.py'), MONITOR_HARNESS_PYTHON);
  return runHarness(dir) as MonitorHarnessReport;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const SWAP_FIELDS = ['total', 'used', 'free', 'percent', 'sin', 'sout'];
const DISK_FIELDS = [
  'read_count',
  'write_count',
  'read_bytes',
  'write_bytes',
  'read_time',
  'write_time',
];

/**
 * Shape assertions shared by both fallback paths (psutil result classes
 * resolvable or absent): per-function arity, `type(reading)(*values)`
 * reconstruction, and pickling across the collector pipe. An svmem-shaped
 * fallback in the swap position wedges mach.
 */
function expectPerFunctionShapes(report: GuardHarnessReport): void {
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
  // The collector child samples per-CPU; scalar fallbacks would break its
  // per-CPU diff arithmetic.
  expect(report.cpu_percent_percpu).toEqual([]);
  expect(report.cpu_times_percpu).toEqual([]);
  // Per-function arity: swap must be sswap-shaped (6), never svmem (8).
  expect(report.swap_fields).toEqual(SWAP_FIELDS);
  expect(report.swap_len).toBe(6);
  expect(report.swap_zeroed).toBe(true);
  expect(report.cpu_times_len).toBe(4);
  expect(report.disk_fields).toEqual(DISK_FIELDS);
  expect(report.disk_len).toBe(6);
  // The parent reconstructs samples via type(reading)(*values) and readings
  // cross the collector pipe via pickle — both must survive.
  expect(report.rebuild_ok).toBe(true);
  expect(report.pickle_ok).toBe(true);
}

describe.skipIf(!pythonAvailable)('mach resource guard degraded fallbacks (python3)', () => {
  it('degrades to zeroed real psutil namedtuples when result classes resolve', async () => {
    const report = await runGuardHarness(FAKE_PSUTIL_WITH_RESULT_CLASSES);
    expect(report.type).toBe('svmem');
    expectPerFunctionShapes(report);
  });

  it('degrades to guard-owned per-function namedtuples when result classes are absent', async () => {
    const report = await runGuardHarness(FAKE_PSUTIL_WITHOUT_RESULT_CLASSES);
    expect(report.type).toBe('_FallbackVmem');
    expectPerFunctionShapes(report);
  });

  it('suppresses the collector on degradation and keeps mozbuild resource logging non-fatal', async () => {
    const report = await runMonitorHarness();
    // Healthy at init: start reached the orig; the mid-run aggregate_io
    // raise degraded the instance, terminated/drained the collector, and
    // returned a zeroed io shape (usage["io"].read_bytes survives).
    expect(report.b_start_calls).toBe(1);
    expect(report.b_io_len).toBe(6);
    expect(report.b_io_read_bytes).toBe(0);
    expect(report.b_io_zeroed).toBe(true);
    expect(report.b_process_terminated).toBe(true);
    expect(report.b_process_joined).toBe(true);
    expect(report.b_pipe_drained).toBe(true);
    expect(report.b_cpu_percent_scalar).toBe(0);
    expect(report.b_cpu_percent_percpu).toEqual([]);
    expect(report.b_cpu_times_len).toBe(4);
    // Degraded stop never reaches the orig (which could re-wedge the drain).
    expect(report.b_stop_calls).toBe(0);
    // Host has degraded once: fresh monitors stay inert — the collector
    // child is never started, so a malformed sample stream cannot exist.
    expect(report.a_start_calls).toBe(0);
    expect(report.a_process_terminated).toBe(true);
    expect(report.a_io_len).toBe(6);
    expect(report.a_io_read_bytes).toBe(0);
    // Flapping shape safety: degraded swap readings are 6-field and
    // type-capture reconstruction survives both flapping directions.
    expect(report.degraded_swap_len).toBe(6);
    expect(report.rebuild_across_flap_ok).toBe(true);
    // BuildMonitor.log_resource_usage warns and continues instead of
    // failing a build with complete artifacts.
    expect(report.bm_result_is_none).toBe(true);
    expect(report.bm_warned).toBe(true);
  });
});
