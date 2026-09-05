// SPDX-License-Identifier: EUPL-1.2
/**
 * Resource-monitor degrade guard for mach dispatches.
 *
 * mozbuild's build resource monitor calls `psutil.virtual_memory()` at
 * startup (`start_resource_recording`) and again later from
 * `mozbuild.base._run_make`. On some hosts those raise `RuntimeError:
 * host_statistics64(HOST_VM_INFO64) syscall failed`, and a
 * `SystemResourceMonitor.__init__` that fails partway leaves an instance
 * without `poll_interval`, so later polling dies with `AttributeError: ...
 * poll_interval`. Any of these aborts `mach build` / `mach build faster`
 * before the compiler ever runs.
 *
 * The guard is installed as a `fireforge_mach_guard.pth` + module pair in
 * every discovered mach virtualenv site-packages directory. A PYTHONPATH
 * `sitecustomize.py` is NOT sufficient on its own: mach re-execs itself into
 * its private virtualenv and drops PYTHONPATH, so that route never loads.
 * `.pth` files execute at interpreter startup from the venv's own
 * site-packages, which survives the re-exec. The PYTHONPATH copy is retained
 * only for the pre-venv bootstrap phase (first build, no `_virtualenvs` on
 * disk yet).
 *
 * The guard covers the whole crash family:
 *  - wraps `psutil.virtual_memory` / `swap_memory` / `cpu_percent` /
 *    `cpu_times` / `disk_io_counters` module-wide, so every call site —
 *    including the direct `psutil.virtual_memory()` in
 *    `mozbuild.base._run_make` — degrades to a `UserWarning` and a zeroed
 *    reading instead of aborting.
 *
 *    The fallback must be per-function ARITY-CORRECT and reconstructible:
 *    mozsystemmonitor captures reading types at `__init__`
 *    (`self._swap_type = type(psutil.swap_memory())`) and rebuilds each
 *    collector sample via `self._swap_type(*swap_mem)`. An svmem-shaped
 *    (8-field) fallback in the swap (6-field `sswap`) position makes the
 *    parent reject every sample and break its drain loop, so the pipe fills,
 *    the collector child blocks in `send()` and never reads the terminate
 *    sentinel, and mach hangs forever in its atexit `waitpid`. Each wrapped
 *    function therefore degrades to a zeroed instance of psutil's own result
 *    namedtuple where resolvable, else a module-level guard-owned namedtuple
 *    with the exact field order and arity for THAT function (module-level so
 *    readings pickle by reference across the collector pipe).
 *    `_DegradedReading` remains only as a documented last resort and
 *    tolerates `type(reading)(*values)` reconstruction. Guard-owned fallback
 *    classes never depend on psutil internals resolving, which also makes
 *    them safe when two guard copies load (PYTHONPATH `sitecustomize` in the
 *    bootstrap phase plus the in-venv `.pth`), each with its own classes;
 *  - guards `SystemResourceMonitor` CONSTRUCTION via an import hook:
 *    `poll_interval` is pre-populated before the real `__init__` runs, a
 *    failing `__init__` marks the instance degraded instead of raising, and
 *    every monitor method no-ops on a degraded instance — so a
 *    partially-constructed monitor can never surface the
 *    `AttributeError: poll_interval` variant. Degraded aggregate methods
 *    return zeroed shapes (not `None`) where callers subscript the result
 *    (`aggregate_io` → zeroed io reading, so mozbuild's `log_resource_usage`
 *    does not die on `usage["io"].read_bytes` after a successful compile);
 *  - suppresses the mozsystemmonitor collector child on degradation: once
 *    any psutil degradation is observed in the process, monitors are kept
 *    inert (`start` never spawns the collector), and a degraded transition
 *    or raising `stop` best-effort terminates a live collector child and
 *    drains the pipe, so a malformed sample stream cannot wedge mach's
 *    shutdown even if a future shape mismatch slips through;
 *  - wraps `mozbuild.controller.building.BuildMonitor.log_resource_usage` to
 *    warn-and-continue on any exception, so end-of-build resource reporting
 *    can never fail a build whose artifacts are complete.
 */

import { lstat, mkdir, readdir } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

import { BuildError } from '../errors/build.js';
import { toError } from '../utils/errors.js';
import { pathExists, writeText } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';

/**
 * Prefix of the per-user directory (under the OS temp dir) holding the
 * PYTHONPATH fallback. The uid (or, on Windows, the username) is appended:
 * a FIXED name under a shared `/tmp` lets any other local account pre-create
 * the directory and own the `sitecustomize.py` that every mach dispatch
 * then imports.
 */
const RESOURCE_SHIM_DIRNAME = 'fireforge-mach-resource-shim';

/** Basename (sans extension) of the in-venv guard module. */
const GUARD_MODULE_NAME = 'fireforge_mach_guard';

/**
 * Python guard body, importable both as the in-venv `fireforge_mach_guard`
 * module (loaded by the sibling `.pth` at interpreter startup) and as the
 * PYTHONPATH `sitecustomize` fallback. Defensive throughout: a missing or
 * broken psutil/mozsystemmonitor leaves mach untouched, and every wrapper
 * only intercepts the failure path. Exported for the Python-executing
 * regression test (mach-resource-shim.python.test.ts), which asserts the
 * degraded readings' runtime behavior rather than string-matching the source.
 */
export const GUARD_PYTHON_SOURCE = `# Generated by FireForge - do not edit.
# Degrades the broken host resource monitor family (psutil vs Darwin) from
# fatal startup errors into non-fatal warnings, so mach builds and tests
# proceed. Installed into the mach virtualenv site-packages via a .pth file
# (survives mach's venv re-exec, which drops PYTHONPATH).
import builtins
import collections
import inspect
import sys
import warnings

# Any psutil degradation observed in this process. Once set, monitors are
# kept inert (start never spawns the collector child) — on a flapping host a
# healthy-looking moment must not be trusted to start a sample stream that a
# later degraded reading could malform.
_fireforge_host_degraded = [False]


def _fireforge_degraded_notice(exc):
    _fireforge_host_degraded[0] = True
    warnings.warn(
        "FireForge: host resource monitor degraded (%s); continuing without resource monitoring." % exc
    )


class _DegradedReading(object):
    # Last-resort duck type of psutil's namedtuple results (svmem field
    # order): mozsystemmonitor subscripts, iterates, and unpacks readings,
    # so the degraded fallback must survive r[0], list(r), len(r), r._fields
    # and r._asdict(), not just attribute access. The parent also reconstructs
    # readings via type(reading)(*values), so the constructor must tolerate
    # the full positional field list. Normal
    # degraded paths use the per-function namedtuple fallbacks below; this
    # class only backstops a fallback that itself raised.
    _fields = ("total", "available", "percent", "used", "free", "active", "inactive", "wired")
    total = available = used = free = active = inactive = wired = 0
    percent = 0.0

    def __init__(self, *_args, **_kwargs):
        pass

    def __getattr__(self, _name):
        return 0

    def _values(self):
        return tuple(getattr(self, _field) for _field in self._fields)

    def __getitem__(self, index):
        return self._values()[index]

    def __iter__(self):
        return iter(self._values())

    def __len__(self):
        return len(self._fields)

    def _asdict(self):
        return dict(zip(self._fields, self._values()))


# Per-function fallback result classes with the exact macOS field
# orders/arities. Module-level on purpose: readings cross the
# mozsystemmonitor collector pipe via pickle (by reference), and the parent
# rebuilds each sample with type(reading)(*values) — so a swap fallback must
# be 6-field sswap-shaped in every position. An svmem-shaped fallback there
# makes the parent reject every sample, fill the pipe, block the collector
# child in send(), and wedge mach's atexit join forever.
_FallbackVmem = collections.namedtuple(
    "_FallbackVmem",
    ("total", "available", "percent", "used", "free", "active", "inactive", "wired"),
)
_FallbackSwap = collections.namedtuple(
    "_FallbackSwap", ("total", "used", "free", "percent", "sin", "sout")
)
_FallbackCpuTimes = collections.namedtuple("_FallbackCpuTimes", ("user", "nice", "system", "idle"))
_FallbackDiskIO = collections.namedtuple(
    "_FallbackDiskIO",
    ("read_count", "write_count", "read_bytes", "write_bytes", "read_time", "write_time"),
)

_FALLBACK_CLASSES = {
    "virtual_memory": _FallbackVmem,
    "swap_memory": _FallbackSwap,
    "cpu_times": _FallbackCpuTimes,
    "disk_io_counters": _FallbackDiskIO,
}

# psutil result namedtuple per wrapped function, resolvable via getattr from
# the platform module / _common without invoking the failing syscall.
_PSUTIL_RESULT_CLASSES = {
    "virtual_memory": "svmem",
    "swap_memory": "sswap",
    "cpu_times": "scputimes",
    "disk_io_counters": "sdiskio",
}


def _zeroed(cls):
    return cls(*([0] * len(cls._fields)))


def _percpu_requested(args, kwargs, positional_index):
    if "percpu" in kwargs:
        return bool(kwargs["percpu"])
    return len(args) > positional_index and bool(args[positional_index])


def _degraded_result_factory(psutil, name):
    # cpu_percent returns a plain float (or a per-CPU list) callers do
    # arithmetic on.
    if name == "cpu_percent":
        def _cpu_percent_fallback(*args, **kwargs):
            # cpu_percent(interval=None, percpu=False)
            if _percpu_requested(args, kwargs, 1):
                return []
            return 0.0

        return _cpu_percent_fallback
    # The guard-owned class is always shape-correct for this function;
    # psutil's own result namedtuple is still preferred when resolvable so
    # type() captures stay identical to real readings on a flapping host.
    _cls = _FALLBACK_CLASSES.get(name, _DegradedReading)
    _cls_name = _PSUTIL_RESULT_CLASSES.get(name)
    if _cls_name is not None:
        for _mod in (getattr(psutil, "_psplatform", None), getattr(psutil, "_common", None)):
            _real = getattr(_mod, _cls_name, None) if _mod is not None else None
            if _real is not None and getattr(_real, "_fields", None):
                _cls = _real
                break
    if name == "cpu_times":
        def _cpu_times_fallback(*args, **kwargs):
            # cpu_times(percpu=False); the collector child samples per-CPU.
            if _percpu_requested(args, kwargs, 0):
                return []
            return _zeroed(_cls)

        return _cpu_times_fallback

    def _reading_fallback(*_args, **_kwargs):
        return _zeroed(_cls)

    return _reading_fallback


def _guard_psutil():
    try:
        import psutil
    except Exception:
        return

    def _wrap(orig, fallback):
        def wrapper(*args, **kwargs):
            try:
                return orig(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                _fireforge_degraded_notice(exc)
                try:
                    return fallback(*args, **kwargs)
                except Exception:  # noqa: BLE001
                    return _DegradedReading()

        return wrapper

    for _name in ("virtual_memory", "swap_memory", "cpu_percent", "cpu_times", "disk_io_counters"):
        _orig = getattr(psutil, _name, None)
        if _orig is not None and not getattr(_orig, "_fireforge_guarded", False):
            try:
                _fallback = _degraded_result_factory(psutil, _name)
            except Exception:  # noqa: BLE001
                _fallback = _DegradedReading
            _wrapped = _wrap(_orig, _fallback)
            _wrapped._fireforge_guarded = True
            setattr(psutil, _name, _wrapped)


_MONITOR_METHOD_NAMES = (
    "start",
    "stop",
    "record_event",
    "record_marker",
    "begin_phase",
    "finish_phase",
    "aggregate_cpu_percent",
    "aggregate_cpu_times",
    "aggregate_io",
    "min_memory_available",
    "as_dict",
)


def _fireforge_stop_collector(monitor):
    # Best-effort: terminate a live collector child and drain the parent end
    # of the pipe, so a child blocked in send() on a full pipe can never
    # keep mach's atexit join (os.waitpid) waiting forever. Attribute names
    # follow upstream resourcemonitor.py (self._process / self._pipe); a
    # miss on a refactored upstream is harmless — the shape-correct
    # fallbacks above still keep the sample stream well-formed.
    try:
        proc = getattr(monitor, "_process", None)
        if proc is not None and getattr(proc, "is_alive", lambda: False)():
            proc.terminate()
            proc.join(1)
    except Exception:  # noqa: BLE001
        pass
    try:
        pipe = getattr(monitor, "_pipe", None)
        if pipe is not None:
            while pipe.poll(0):
                pipe.recv()
    except Exception:  # noqa: BLE001
        pass


def _monitor_per_cpu_requested(args, kwargs):
    # aggregate_cpu_percent/aggregate_cpu_times(start=None, end=None,
    # phase=None, per_cpu=True) — self already stripped from args.
    if "per_cpu" in kwargs:
        return bool(kwargs["per_cpu"])
    if len(args) > 3:
        return bool(args[3])
    return True


def _monitor_degraded_result(name, args, kwargs):
    # Degraded aggregate methods return zeroed shapes, not None, where
    # callers subscript the result: mozbuild's log_resource_usage does
    # usage["io"].read_bytes after a successful compile, so None there fails
    # the build with complete artifacts already on disk.
    if name == "aggregate_io":
        return _zeroed(_FallbackDiskIO)
    if name == "aggregate_cpu_percent":
        return [] if _monitor_per_cpu_requested(args, kwargs) else 0.0
    if name == "aggregate_cpu_times":
        return [] if _monitor_per_cpu_requested(args, kwargs) else _zeroed(_FallbackCpuTimes)
    return None


def _patch_monitor_class(cls):
    if cls is None or getattr(cls, "_fireforge_guarded", False):
        return
    orig_init = cls.__init__

    def guarded_init(self, *args, **kwargs):
        # Pre-populate the attributes a partially-constructed instance is
        # later polled for, so a failing __init__ can never surface
        # AttributeError: poll_interval.
        self.poll_interval = kwargs.get("poll_interval") or 1.0
        self._fireforge_degraded = False
        try:
            orig_init(self, *args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            self._fireforge_degraded = True
            _fireforge_degraded_notice(exc)
        if _fireforge_host_degraded[0] and not self._fireforge_degraded:
            # Host already degraded once: keep the monitor inert so the
            # collector child never spawns on a flapping host.
            self._fireforge_degraded = True
        if self._fireforge_degraded:
            _fireforge_stop_collector(self)

    cls.__init__ = guarded_init

    def _wrap_method(name, orig):
        def wrapper(self, *args, **kwargs):
            if (
                name == "start"
                and _fireforge_host_degraded[0]
                and not getattr(self, "_fireforge_degraded", False)
            ):
                self._fireforge_degraded = True
                _fireforge_stop_collector(self)
            if getattr(self, "_fireforge_degraded", False):
                if name == "stop":
                    _fireforge_stop_collector(self)
                return _monitor_degraded_result(name, args, kwargs)
            try:
                return orig(self, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                self._fireforge_degraded = True
                _fireforge_degraded_notice(exc)
                # A raising stop (or any degraded transition) must still
                # take the collector child down, or the parent's atexit
                # join hangs on a child blocked writing to a full pipe.
                _fireforge_stop_collector(self)
                return _monitor_degraded_result(name, args, kwargs)

        return wrapper

    def _wrap_unbound(name, func):
        # Upstream declares record_event/record_marker as @staticmethods (and
        # may declare others as @classmethods). Those take no receiver, so
        # they cannot use the per-instance degraded flag and must not have one
        # threaded in — see the descriptor dispatch below.
        def wrapper(*args, **kwargs):
            if _fireforge_host_degraded[0]:
                return _monitor_degraded_result(name, args, kwargs)
            try:
                return func(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                _fireforge_degraded_notice(exc)
                return _monitor_degraded_result(name, args, kwargs)

        return wrapper

    for _name in _MONITOR_METHOD_NAMES:
        # getattr_static returns the raw class attribute, so a staticmethod
        # is still a staticmethod object here. Plain getattr would hand back
        # the underlying function, and re-setting THAT on the class rebinds
        # it as an instance method: the receiver is then passed through as an
        # extra leading positional and every call raises
        # "takes N positional arguments but N+1 were given". Re-apply the
        # descriptor the attribute actually had.
        try:
            _raw = inspect.getattr_static(cls, _name)
        except AttributeError:
            continue
        if isinstance(_raw, staticmethod):
            setattr(cls, _name, staticmethod(_wrap_unbound(_name, _raw.__func__)))
            continue
        if isinstance(_raw, classmethod):
            setattr(cls, _name, classmethod(_wrap_unbound(_name, _raw.__func__)))
            continue
        _orig = getattr(cls, _name, None)
        if _orig is not None:
            setattr(cls, _name, _wrap_method(_name, _orig))
    cls._fireforge_guarded = True


def _patch_build_monitor_class(cls):
    # mozbuild's BuildMonitor is not a SystemResourceMonitor; only
    # log_resource_usage needs guarding — end-of-build resource reporting
    # must never fail a build whose artifacts are complete. No __init__
    # replacement, no degraded-instance gating.
    if cls is None or getattr(cls, "_fireforge_guarded", False):
        return
    _orig = getattr(cls, "log_resource_usage", None)
    if _orig is not None:
        def _guarded_log_resource_usage(self, *args, **kwargs):
            try:
                return _orig(self, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                _fireforge_degraded_notice(exc)
                return None

        cls.log_resource_usage = _guarded_log_resource_usage
    cls._fireforge_guarded = True


_MONITOR_CLASS_PATCHES = (
    ("mozsystemmonitor.resourcemonitor", "SystemResourceMonitor", _patch_monitor_class),
    ("mozbuild.resources", "SystemResourceMonitor", _patch_monitor_class),
    ("mozbuild.controller.building", "BuildMonitor", _patch_build_monitor_class),
)


def _patch_loaded_monitor_modules():
    for _mod_name, _cls_name, _patcher in _MONITOR_CLASS_PATCHES:
        _mod = sys.modules.get(_mod_name)
        if _mod is not None:
            try:
                _patcher(getattr(_mod, _cls_name, None))
            except Exception:  # noqa: BLE001
                pass


def _install_import_hook():
    _orig_import = builtins.__import__
    if getattr(_orig_import, "_fireforge_guarded", False):
        return

    def _guarding_import(name, *args, **kwargs):
        _module = _orig_import(name, *args, **kwargs)
        try:
            _patch_loaded_monitor_modules()
        except Exception:  # noqa: BLE001
            pass
        return _module

    _guarding_import._fireforge_guarded = True
    builtins.__import__ = _guarding_import


try:
    _guard_psutil()
    _patch_loaded_monitor_modules()
    _install_import_hook()
except Exception:  # noqa: BLE001
    pass
`;

/** Result of installing the mach resource guard before a dispatch. */
export interface MachResourceGuardInstallation {
  /**
   * Env overlay for the mach subprocess: the PYTHONPATH sitecustomize
   * fallback that covers the pre-venv bootstrap phase. Merged over
   * `process.env` by the exec layer.
   */
  env: Record<string, string>;
  /** site-packages directories the in-venv guard was written into. */
  sitePackagesDirs: string[];
}

/** Lists subdirectory names of `dir`, tolerating a missing directory. */
async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // An unreadable directory contributes no subdirectories to the shim scan.
    return [];
  }
}

/**
 * Discovers `site-packages` directories of the mach virtualenvs under one
 * `_virtualenvs` root: `<root>/<venv>/lib/python<N.M>/site-packages`.
 */
async function discoverVenvSitePackages(virtualenvsDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const venvName of await listSubdirs(virtualenvsDir)) {
    const libDir = join(virtualenvsDir, venvName, 'lib');
    for (const pythonName of await listSubdirs(libDir)) {
      if (!pythonName.startsWith('python')) continue;
      const sitePackages = join(libDir, pythonName, 'site-packages');
      if (await pathExists(sitePackages)) {
        found.push(sitePackages);
      }
    }
  }
  return found;
}

/**
 * Discovers every mach virtualenv site-packages dir relevant to an engine
 * checkout: the objdir venvs (under `<engineDir>/obj-&lt;x&gt;/_virtualenvs`)
 * and the mach state-dir venvs (under `$MOZBUILD_STATE_PATH` or
 * `~/.mozbuild`, in `srcdirs/&lt;hash&gt;/_virtualenvs`, where mach keeps the
 * `mach` command venv itself).
 */
async function discoverMachSitePackages(engineDir: string): Promise<string[]> {
  const found: string[] = [];

  for (const name of await listSubdirs(engineDir)) {
    if (!name.startsWith('obj-')) continue;
    found.push(...(await discoverVenvSitePackages(join(engineDir, name, '_virtualenvs'))));
  }

  const stateDir = process.env['MOZBUILD_STATE_PATH'] ?? join(homedir(), '.mozbuild');
  for (const srcdirName of await listSubdirs(join(stateDir, 'srcdirs'))) {
    found.push(
      ...(await discoverVenvSitePackages(join(stateDir, 'srcdirs', srcdirName, '_virtualenvs')))
    );
  }

  return found;
}

/**
 * Per-user discriminator for the shim directory name. The numeric uid on
 * POSIX, read via `process.getuid` rather than `os.userInfo()`: the latter
 * resolves the passwd entry and THROWS (`ERR_SYSTEM_ERROR`) for a uid that
 * has none — `docker --user 1001:1001`, OpenShift's random uids, many CI
 * agents — which would take every build and test dispatch down with a raw
 * system error. On Windows there is no uid; the username is the
 * discriminator, with `userInfo()` still guarded because the same lookup
 * can fail there for a service account, falling back to the environment.
 */
function shimDirOwner(): string {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    username = process.env['USERNAME'] ?? process.env['USER'];
  }
  return (username ?? 'unknown-user').replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Per-user shim directory: `<tmpdir>/fireforge-mach-resource-shim-<uid>`. */
function resourceShimDir(): string {
  return join(tmpdir(), `${RESOURCE_SHIM_DIRNAME}-${shimDirOwner()}`);
}

/**
 * Refuses a shim directory that is not a private directory of the current
 * user. `lstat`, not `stat`: a symlink planted at the path would otherwise
 * be followed and the check would describe its target. On Windows only the
 * "is a real directory" half applies — there is no POSIX owner or mode bit
 * to read, and the per-user name is the isolation.
 *
 * @param dir - Shim directory that {@link ensureSitecustomizeFallback} created
 * @throws BuildError when the directory is a symlink/file, owned by another
 *   uid, or group/world-writable
 */
export async function assertPrivateShimDir(dir: string): Promise<void> {
  const stats = await lstat(dir);
  const refuse = (reason: string): never => {
    throw new BuildError(
      `Refusing to use mach resource shim directory ${dir}: ${reason}. ` +
        'Another local account may have planted it; remove or fix it and retry.'
    );
  };
  if (!stats.isDirectory()) {
    refuse('not a directory (symlink or file)');
  }
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    refuse(`owned by uid ${stats.uid}, not the current user (uid ${uid})`);
  }
  if ((stats.mode & 0o022) !== 0) {
    refuse(`mode ${(stats.mode & 0o777).toString(8)} is group/world-writable`);
  }
}

/**
 * Writes the PYTHONPATH `sitecustomize.py` fallback into a per-user,
 * mode-0700 FireForge-owned temp directory, verified private before the
 * write, and returns that directory. Idempotent — overwriting each call
 * keeps it in sync with this source across upgrades.
 */
async function ensureSitecustomizeFallback(): Promise<string> {
  const dir = resourceShimDir();
  // `mode` only applies when mkdir creates the directory (and is masked by
  // the umask); a pre-existing one keeps whatever it had, which is exactly
  // what the assertion below refuses if it is not private.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateShimDir(dir);
  await writeText(join(dir, 'sitecustomize.py'), GUARD_PYTHON_SOURCE);
  return dir;
}

/**
 * Builds the `env` overlay (merged over `process.env` by the exec layer)
 * that prepends the fallback shim directory to `PYTHONPATH` without
 * clobbering an existing `PYTHONPATH`.
 */
function machResourceShimEnv(
  shimDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const existing = baseEnv['PYTHONPATH'];
  return { PYTHONPATH: existing ? `${shimDir}${delimiter}${existing}` : shimDir };
}

/**
 * Installs the resource-monitor degrade guard for a mach dispatch:
 * `fireforge_mach_guard.pth` + `fireforge_mach_guard.py` into every
 * discovered mach virtualenv site-packages (survives mach's venv re-exec),
 * plus the PYTHONPATH sitecustomize fallback for the pre-venv bootstrap
 * phase. Idempotent and re-run before EVERY protected dispatch (including
 * each retry) so a venv created by a crashed first attempt is guarded on
 * the next one instead of re-dying on the same wedged state.
 */
export async function installMachResourceGuard(
  engineDir: string
): Promise<MachResourceGuardInstallation> {
  const sitePackagesDirs = await discoverMachSitePackages(engineDir);
  for (const sitePackages of sitePackagesDirs) {
    try {
      await writeText(join(sitePackages, `${GUARD_MODULE_NAME}.py`), GUARD_PYTHON_SOURCE);
      await writeText(
        join(sitePackages, `${GUARD_MODULE_NAME}.pth`),
        `import ${GUARD_MODULE_NAME}\n`
      );
    } catch (error: unknown) {
      // A read-only or vanished venv must not block the dispatch; the
      // PYTHONPATH fallback still applies and other venvs may have taken
      // the guard.
      verbose(
        `Could not install mach resource guard into ${sitePackages}: ${toError(error).message}`
      );
    }
  }

  const env = machResourceShimEnv(await ensureSitecustomizeFallback());
  return { env, sitePackagesDirs };
}
