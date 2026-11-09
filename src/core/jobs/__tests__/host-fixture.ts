// SPDX-License-Identifier: EUPL-1.2
/** A whole host in a directory: a project, a pristine engine with a fake mach, real-shaped configure output and fake tools. */
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPlatform } from '../../../utils/platform.js';
import { commitFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { sourceGit } from '../../authored/git.js';
import { initializeCoordinator } from '../client.js';
import { readJson } from '../store.js';

const SUPERVISOR_IDLE_MS = 5_000;
/**
 * A quiet limit no host reaches. The supervisor reads the real one-minute load, so
 * a fixture namespace with the default limit would hold every quiet phase for as
 * long as anything else on the machine is busy. `host init` keeps a stated limit,
 * so the namespace's own commands leave this in place.
 */
export const FIXTURE_QUIET_LOAD = 1_000_000;

/**
 * The memory, in GiB, a fixture namespace states for jobs together. Each slot
 * reserves a working set against it, so a fixture's slots fit however much
 * memory this machine has, and `host init` keeps a stated value.
 */
export const FIXTURE_MEMORY_GIB = 32;
const packageRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const entry = join(packageRoot, 'bin/fireforge.ts');
const loader = join(packageRoot, 'src/core/jobs/source-loader-bootstrap.cjs');

/** Answers what FireForge asks of mach: provisioning a site, configure, build, test and clobber. */
const FAKE_MACH = String.raw`MIN_PYTHON_VERSION = (3, 8)
MAX_PYTHON_VERSION_TO_CONSIDER = (3, 20)
import hashlib, json, os, re, subprocess, sys, time

engine = os.path.dirname(os.path.realpath(__file__))
args = sys.argv[1:]
TOOLS = ["CXX", "HOST_CC", "HOST_CXX", "RUSTC", "CARGO", "RUSTDOC", "AR", "STRIP", "NODEJS", "DSYMUTIL", "CBINDGEN", "WASM_CC"]
# Reads a mozconfig the way the real loader does: sourced, with the two option functions defined.
LOADER = 'ac_add_options() { for o; do echo "AC:$o"; done; }; mk_add_options() { for o; do echo "MK:$o"; done; }; topsrcdir="$1"; . "$2"'


def mozconfig_lines():
    path = os.environ.get("MOZCONFIG") or os.path.join(engine, "mozconfig")
    if not os.path.exists(path):
        return []
    return subprocess.run(["sh", "-c", LOADER, "loader", engine, path], check=True, capture_output=True, text=True).stdout.splitlines()


def option(prefix):
    found = [line[len(prefix):] for line in mozconfig_lines() if line.startswith(prefix)]
    return found[-1] if found else None


objdir = option("MK:MOZ_OBJDIR=") or os.path.join(engine, "obj-fake")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


def provision(site):
    state = os.environ["MOZBUILD_STATE_PATH"]
    tag = hashlib.sha256(os.path.realpath(engine).encode()).hexdigest()[:12]
    parent = os.path.join(state, "srcdirs", "engine-" + tag, "_virtualenvs")
    for name in sorted({"mach", "common", site}):
        root = os.path.join(parent, name)
        os.makedirs(os.path.join(root, "bin"), exist_ok=True)
        # A real site's path names mach's site-packages as well as its own.
        packages = os.path.join(parent, "mach", "lib", "python3.12", "site-packages")
        os.makedirs(packages, exist_ok=True)
        with open(root + ".lock", "w") as lock:
            lock.write("mach lock")
        binary = os.path.join(root, "bin", "python")
        if not os.path.exists(binary):
            probe = {"executable": sys.executable, "prefix": root, "paths": [root, engine, packages]}
            write(binary, "#!/bin/sh\nprintf '%s\\n' '" + "FIREFORGE_NATIVE_PROBE:" + json.dumps(probe) + "'\n")
            os.chmod(binary, 0o755)
    print("provisioned", site)


def configure():
    write(os.path.join(objdir, "config.status"), "topsrcdir=" + engine + "\n")
    write(os.path.join(objdir, "mozinfo.json"), json.dumps({"topsrcdir": engine, "topobjdir": objdir, "mozconfig": os.path.join(engine, "mozconfig")}))
    substs = {key: os.environ[key] for key in TOOLS if key in os.environ}
    # What real configure does with its inputs: an SDK its CC names, and paths it derives or looks for.
    sdk = option("AC:--with-macos-sdk=") or os.environ.get("MACOS_SDK_DIR") or "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
    substs["CC"] = os.environ.get("CC", "") + " -isysroot " + sdk
    substs["MACOS_SDK_DIR"] = sdk
    if "WASI_SYSROOT" in os.environ:
        substs["WASI_SYSROOT"] = os.environ["WASI_SYSROOT"]
    onnx = option("AC:--with-onnx-runtime=")
    if onnx:
        substs["ONNX_RUNTIME"] = os.path.join(onnx, "libonnxruntime.dylib")
    for key, value in substs.items():
        write(os.path.join(objdir, "config.statusd", "substs", key), json.dumps(value))
    write(os.path.join(objdir, "backend.mk"), "# " + engine + "\n")
    print("configured", engine)


if args[:1] == ["python"]:
    provision(args[args.index("--virtualenv") + 1])
elif args[:1] == ["configure"]:
    configure()
elif args[:1] == ["build"]:
    # A source states that its build goes red.
    try:
        if "fake-mach-build-red" in open(os.path.join(engine, "browser/themes/shared/tabs.css")).read():
            print("error: the build went red", file=sys.stderr)
            sys.exit(1)
    except OSError:
        pass
    if not os.path.exists(os.path.join(objdir, "config.status")):
        configure()
    binary = os.path.join(objdir, "dist", "Fixture.app", "Contents", "MacOS", "fixture")
    write(binary, "#!/bin/sh\nexit 0\n")
    os.chmod(binary, 0o755)
    write(os.path.join(objdir, "dist", "bin", "fixture"), "built " + str(time.time()) + "\n")
    print("build complete", args)
elif args[:1] in (["test"], ["mochitest"], ["xpcshell-test"]):
    log = None
    for index, arg in enumerate(args):
        if arg == "--log-raw":
            log = args[index + 1]
        elif arg.startswith("--log-raw="):
            log = arg.split("=", 1)[1]
    tests = [arg for arg in args[1:] if arg.endswith(".js")]
    # A test states when it reddens: while a marker exists, or while an engine file holds a text.
    def red(test):
        try:
            text = open(os.path.join(engine, test)).read()
        except OSError:
            return False
        for marker in re.findall(r"fake-mach-red-while (\S+)", text):
            if os.path.exists(marker):
                return True
        for target, needle in re.findall(r"fake-mach-red-if (\S+) (\S+)", text):
            try:
                if needle in open(os.path.join(engine, target)).read():
                    return True
            except OSError:
                pass
        return False
    reds = [test for test in tests if red(test)]
    # What xpcshell does with a roster of no tests: it starts its HTTP/2 server in a session of its
    # own, then exits on "no tests to run" without stopping it. Double-forked, so it is reparented
    # before any sample can see it as a descendant.
    for test in tests:
        try:
            text = open(os.path.join(engine, test)).read()
        except OSError:
            continue
        for pidfile, node in re.findall(r"fake-mach-orphan-helper (\S+) (\S+)", text):
            if os.fork() == 0:
                server = os.path.join(engine, "testing", "xpcshell", "moz-http2", "moz-http2.js")
                helper = subprocess.Popen([node, "-e", "setTimeout(()=>{},60000)", server], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                write(pidfile, str(helper.pid))
                os._exit(0)
            os.wait()
            print("no tests to run using specified combination of filters", file=sys.stderr)
            sys.exit(1)
    # A test states where to leave what the harness saw: its environment and its arguments.
    for test in tests:
        try:
            text = open(os.path.join(engine, test)).read()
        except OSError:
            continue
        for path in re.findall(r"fake-mach-record (\S+)", text):
            with open(path, "w") as out:
                json.dump({"env": dict(os.environ), "args": args, "pid": os.getpid()}, out)
        # A test can hold the harness open while a file exists, so a phase can be caught in flight.
        for path in re.findall(r"fake-mach-hold (\S+)", text):
            while os.path.exists(path):
                time.sleep(0.05)
    # The real harness writes its pref census here, and only here, when the variable is set.
    upload = os.environ.get("MOZ_UPLOAD_DIR")
    if upload:
        write(os.path.join(upload, "modifiedPrefs.json"), json.dumps({"from": engine}))
    for test in tests:
        print("TEST-START | " + test)
        print("TEST-OK | " + test + " | took 1ms")
    if log:
        now = int(time.time() * 1000)
        def line(**fields):
            return json.dumps({"time": now, "pid": 1, "thread": "main", "source": "fake", **fields}) + "\n"
        with open(log, "w") as out:
            out.write(line(action="suite_start", tests={"default": tests}, run_info={}))
            for test in tests:
                out.write(line(action="test_start", test=test))
                out.write(line(action="test_status", test=test, subtest="ok", status="FAIL" if test in reds else "PASS", expected="PASS"))
                out.write(line(action="test_end", test=test, status="OK", expected="OK"))
            out.write(line(action="suite_end"))
    print("SUITE-END | took 1ms")
    sys.exit(1 if reds else 0)
elif args[:1] == ["package"]:
    # Real packaging resolves its DMG tools through mach taskgraph, which provisions the taskgraph site.
    provision("taskgraph")
    write(os.path.join(objdir, "dist", "fixture-153.6.0.en-US.mac.dmg"), "dmg")
    print("packaged", os.environ.get("MOZ_BUILD_DATE"))
elif args[:1] == ["run"]:
    print("ran the browser", args, flush=True)
    # A profile remembers its sessions, and holds its window open while it has a hold file.
    if "-profile" in args:
        profile = args[args.index("-profile") + 1]
        sessions = os.path.join(profile, "fake-mach-sessions")
        with open(sessions, "a") as out:
            out.write("session\n")
        with open(sessions) as handle:
            print("profile sessions", len(handle.read().splitlines()), flush=True)
        hold = os.path.join(profile, "fake-mach-hold")
        if os.path.exists(hold):
            print("holding the window open", flush=True)
            while os.path.exists(hold):
                time.sleep(0.05)
elif args[:1] == ["clobber"]:
    import shutil
    shutil.rmtree(objdir, ignore_errors=True)
else:
    print("unsupported mach", args, file=sys.stderr)
    sys.exit(2)
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HostFixture {
  directory: string;
  /** The main checkout. */
  project: string;
  /** The pristine engine, at the place a checkout looks for one. */
  pristine: string;
  commit: string;
  /** A configured engine the toolchain derives from. */
  donor: string;
  /** Where the fake tools live, shaped like a home directory. */
  home: string;
  namespace: string;
  toolchains: string;
  /** Runs the CLI as an agent would, with nothing but what points it at this fixture. */
  cli: (cwd: string, args: string[], extra?: NodeJS.ProcessEnv) => Promise<CliResult>;
}

const TOOL_FILES = [
  '.mozbuild/clang/bin/clang',
  '.mozbuild/clang/bin/llvm-ar',
  '.mozbuild/clang/bin/llvm-strip',
  '.mozbuild/clang/bin/dsymutil',
  '.mozbuild/node/bin/node',
  '.mozbuild/cbindgen/cbindgen',
  '.rustup/toolchains/stable/bin/rustc',
  '.rustup/toolchains/stable/bin/cargo',
  '.rustup/toolchains/stable/bin/rustdoc',
  '.cargo/bin/rustdoc',
];

/** Configure output in the shapes a real objdir holds: a string with flags, an array and a proxy path. */
function realShapedSubsts(home: string): Record<string, unknown> {
  const clang = `${home}/.mozbuild/clang/bin/clang`;
  const sysroot = `${home}/.mozbuild/MacOSX26.5.sdk`;
  return {
    CC: `${clang} -isysroot ${sysroot} -mmacosx-version-min=11.0`,
    CXX: `${clang}++ -isysroot ${sysroot} -std=gnu++20`,
    HOST_CC: `${clang} -isysroot ${sysroot}`,
    HOST_CXX: `${clang}++ -isysroot ${sysroot}`,
    RUSTC: `${home}/.rustup/toolchains/stable/bin/rustc`,
    CARGO: `${home}/.rustup/toolchains/stable/bin/cargo`,
    RUSTDOC: `${home}/.cargo/bin/rustdoc`,
    AR: `${home}/.mozbuild/clang/bin/llvm-ar`,
    STRIP: `${home}/.mozbuild/clang/bin/llvm-strip`,
    DSYMUTIL: `${home}/.mozbuild/clang/bin/dsymutil`,
    NODEJS: `${home}/.mozbuild/node/bin/node`,
    CBINDGEN: `${home}/.mozbuild/cbindgen/cbindgen`,
    WASM_CC: [clang, '--target=wasm32-wasi', `--sysroot=${home}/.mozbuild/sysroot-wasm32-wasi`],
    WASI_SYSROOT: `${home}/.mozbuild/sysroot-wasm32-wasi`,
    MACOS_SDK_DIR: sysroot,
    ONNX_RUNTIME: `${home}/.mozbuild/onnxruntime-aarch64-apple-darwin/libonnxruntime.dylib`,
  };
}

/** A source file the project's own lint accepts. */
export const lintClean = (body: string): string =>
  `/* This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0. If a copy of the MPL was not distributed with this\n * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\n${body}`;

export const MOZCONFIG =
  'ac_add_options --disable-bootstrap\nac_add_options --enable-application=browser\nac_add_options --with-branding=browser/branding/fixture\n';

/** The fixture host, with the coordinator's idle time short so nothing outlives a test for long. */
export async function hostFixture(
  options: {
    check?: unknown;
    proof?: unknown;
    mozconfig?: string;
    mach?: string;
    /** Further keys for `fireforge.json`. */
    config?: Record<string, unknown>;
    /** Further files upstream's tree holds. */
    pristineFiles?: Record<string, string>;
    /** Further files the project tracks. */
    projectFiles?: Record<string, string>;
  } = {}
): Promise<HostFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-host-test-'));
  const project = join(directory, 'project');
  const pristine = join(directory, 'pristine-build');
  const home = join(directory, 'home');
  const namespace = join(directory, 'coordinator');
  const toolchains = join(directory, 'toolchains');
  const donor = join(directory, 'donor');
  await mkdir(pristine, { recursive: true });
  await mkdir(project, { recursive: true });
  await sourceGit(pristine, ['init', '-q']);
  await writeAt(pristine, 'mach', options.mach ?? FAKE_MACH, true);
  await writeAt(pristine, 'browser/themes/shared/tabs.css', ':root { --tab-radius: 4px; }\n');
  await writeAt(pristine, 'browser/config/version.txt', '153.6.0\n');
  // What the port preflight looks for: a harness that moves off a busy port by itself.
  await writeAt(
    pristine,
    'testing/mochitest/runtests.py',
    '# falling back to port\n("httpPort", None)\n_port_in_use(port)\n_port_in_use(marionette_port)\n'
  );
  await writeAt(pristine, 'browser/moz.configure', 'imply_option("MOZ_APP_VENDOR", "Mozilla")\n');
  await writeAt(pristine, 'browser/branding/unofficial/moz.build', 'DIRS += ["content"]\n');
  await writeAt(
    pristine,
    'browser/branding/unofficial/locales/en-US/brand.properties',
    'brandShorterName=Firefox\nbrandShortName=Firefox\nbrandFullName=Firefox\n'
  );
  await writeAt(
    pristine,
    'browser/branding/unofficial/locales/en-US/brand.ftl',
    '-brand-shorter-name = Firefox\n-brand-short-name = Firefox\n-brand-full-name = Firefox\n-vendor-short-name = Mozilla\n'
  );
  for (const [path, text] of Object.entries(options.pristineFiles ?? {}))
    await writeAt(pristine, path, text);
  await commitFixture(pristine);
  const commit = (await sourceGit(pristine, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  await sourceGit(project, ['init', '-q']);
  await writeAt(project, '.gitignore', 'engine/\n.fireforge/\nnode_modules/\n');
  await writeAt(
    project,
    'fireforge.json',
    JSON.stringify({
      name: 'Fixture',
      vendor: 'Example',
      binaryName: 'fixture',
      appId: 'invalid.example.fixture',
      firefox: { version: '153.6.0esr', product: 'firefox-esr', sha256: 'a'.repeat(64) },
      test: { reapOrphans: 'owned', mochitestPorts: 'auto' },
      sources: {
        schemaVersion: 1,
        mode: 'authored',
        root: 'src',
        metadataRoot: '.fireforge-sources',
        pristineCommit: commit,
      },
      check: options.check ?? {
        skip: ['typecheck', 'furnace-validate', 'token-coverage'],
        extraSteps: [{ name: 'audit', command: 'true', footprint: { static: true } }],
      },
      ...(options.proof === undefined ? {} : { proof: options.proof }),
      ...options.config,
    })
  );
  for (const [path, text] of Object.entries(options.projectFiles ?? {}))
    await writeAt(project, path, text);
  await writeAt(project, 'package.json', '{"name":"fixture","private":true}\n');
  await writeAt(project, 'configs/common.mozconfig', options.mozconfig ?? MOZCONFIG);
  await writeAt(
    project,
    `configs/${getPlatform()}.mozconfig`,
    'ac_add_options --enable-application=browser\n'
  );
  await writeAt(
    project,
    'src/browser/new.js',
    lintClean('/** A value. */\nexport const value = 1;\n')
  );
  await mkdir(join(project, '.fireforge-sources'), { recursive: true });
  await commitFixture(project);
  const engine = join(project, 'engine');
  await rename(pristine, engine);
  for (const file of TOOL_FILES) await writeAt(home, file, '#!/bin/sh\necho tool\n', true);
  await symlink('clang', join(home, '.mozbuild/clang/bin/clang++'));
  await writeAt(home, '.mozbuild/sysroot-wasm32-wasi/lib/libc.a', 'archive');
  await writeAt(home, '.mozbuild/MacOSX26.5.sdk/usr/include/a.h', 'header');
  await writeAt(home, '.mozbuild/onnxruntime-aarch64-apple-darwin/libonnxruntime.dylib', 'dylib');
  const substs = join(donor, 'obj-real', 'config.statusd', 'substs');
  await mkdir(substs, { recursive: true });
  await writeFile(join(donor, 'obj-real', 'config.status'), 'configured\n');
  for (const [key, value] of Object.entries(realShapedSubsts(home)))
    await writeFile(join(substs, key), JSON.stringify(value));
  // Long enough to outlast the gap between a test's commands, each of which would otherwise boot its own supervisor.
  await initializeCoordinator(namespace, {
    idleMs: SUPERVISOR_IDLE_MS,
    quietLoad: FIXTURE_QUIET_LOAD,
    memory: FIXTURE_MEMORY_GIB,
    // Steps read a steady host, not this machine's network, lid, display and operator.
    steadyHost: true,
  });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    FIREFORGE_COORDINATOR: namespace,
    FIREFORGE_TOOLCHAINS: toolchains,
  };
  return {
    directory,
    project,
    pristine: engine,
    commit,
    donor,
    home,
    namespace,
    toolchains,
    cli: (cwd, args, extra = {}) =>
      new Promise((settle) => {
        execFile(
          process.execPath,
          ['--import', loader, entry, ...args],
          { cwd, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 240_000 },
          (error, stdout, stderr) => {
            settle({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr });
          }
        );
      }),
  };
}

/** Waits for the supervisor to retire, thaws what is frozen and deletes everything. */
export async function removeHostFixture(fixture: HostFixture): Promise<void> {
  for (let attempt = 0; attempt < (2 * SUPERVISOR_IDLE_MS) / 50; attempt += 1) {
    const running = await readJson(join(fixture.namespace, 'endpoint.json')).then(
      () => true,
      () => false
    );
    if (!running) break;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  // A supervisor retiring moves its lock aside, which a recursive chmod can trip over.
  for (let attempt = 0; ; attempt += 1) {
    try {
      execFileSync('chmod', ['-R', 'u+rwX', fixture.directory], { stdio: 'ignore' });
      break;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((settle) => setTimeout(settle, 50));
    }
  }
  await rm(fixture.directory, { recursive: true, force: true });
}

/** The tool a fixture's configure would pick, for a test to break. */
export const fixtureTool = (fixture: HostFixture, relative: string): string =>
  join(fixture.home, relative);
