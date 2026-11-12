// SPDX-License-Identifier: EUPL-1.2
/**
 * A minimal synthetic Firefox source tree: enough real-shaped files for the
 * commands to work on, and a stand-in `mach` that records how it was called.
 * Tests add the files their scenario needs on top.
 */
import { execFile } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type FileTree, writeTree } from './temp.js';

const execFileAsync = promisify(execFile);

/** Paths inside the synthetic tree that tests refer to. */
export const SYNTHETIC_FIREFOX_PATHS = {
  browserScript: 'browser/base/content/browser.js',
  serviceModule: 'toolkit/components/example/service.sys.mjs',
  mozbuild: 'browser/modules/moz.build',
  jarManifest: 'browser/base/jar.mn',
  mozConfigure: 'browser/moz.configure',
  brandingPng: 'browser/branding/unofficial/default16.png',
  /** The jar manifest component files are packaged by. */
  widgetsJar: 'toolkit/content/jar.mn',
  /** The lazy custom-element registry, with a subscript list and a module list. */
  customElements: 'toolkit/content/customElements.js',
  /** A stock widget's directory (`moz-card.mjs`, `moz-card.css`). */
  stockWidget: 'toolkit/content/widgets/moz-card',
  /** The moz.build that registers browser-chrome test manifests. */
  browserBaseMozbuild: 'browser/base/moz.build',
  /** Every `mach` call, one JSON object per line; read it with `readMachLog`. */
  machLog: '.mach-state/commands.jsonl',
  /** Written by `mach build`. */
  buildStamp: 'obj-fireforge/dist/bin/.built',
  /** Written by `mach configure` and `mach build`. */
  mozinfo: 'obj-fireforge/mozinfo.json',
} as const;

/** The Python 3 a test runs the stand-in `mach` with directly: Windows installs it as `python`. */
export const HOST_PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/**
 * What a test tells the stand-in `mach` to do for one command, written with
 * {@link scriptMach}. Without a script a command prints `<command> complete`
 * and exits 0.
 */
export interface MachScript {
  /** Lines written to stdout, in order. */
  stdout?: readonly string[];
  /** Lines written to stderr, after stdout's. */
  stderr?: readonly string[];
  /** Exit status (default 0). */
  exit?: number;
  /** Seconds to stay alive after the output, for a test that interrupts or times out. */
  sleep?: number;
  /** Skip what the command would write into the object directory. */
  noArtifacts?: boolean;
  /** Scripts used instead when an argument equals their key, such as one test file per call. */
  byArg?: Readonly<Record<string, MachScript>>;
  /** Records written, one JSON object per line, to the file a `--log-raw=<path>` argument names. */
  rawLog?: readonly unknown[];
  /** An argument vector started in a session of its own before the output, and left running. */
  detach?: readonly string[];
}

/**
 * The stand-in `mach`. It appends `{ args, env }` to the mach log (`env`
 * holds the `MOZ*` variables and those named in `.mach-state/record-env`),
 * follows `.mach-state/script-<command>.json` (a {@link MachScript}), and
 * fails when `.mach-state/fail-<command>` exists. A script can stand in for a
 * test harness: it writes a mozlog raw log where `--log-raw=` says and can
 * leave a helper running in a session of its own.
 *
 * It keeps an object directory the way the real one does: the directory the
 * active mozconfig (`$MOZCONFIG`, else `mozconfig`) declares with
 * `MOZ_OBJDIR`, else `obj-fireforge`. `configure` and `build` record the
 * absolute source and object directories in `mozinfo.json` and
 * `config.status`; `build` also leaves a build stamp and a stand-in for the
 * browser binary named by `.mach-state/binary-name` (default `firefox`, with
 * `.exe` on Windows), which is found but never launched; `package` leaves
 * `dist/<binary>.package`. The Python range it declares is wide on purpose:
 * it runs on whatever Python 3 the host has.
 */
const MACH_SCRIPT = `#!/usr/bin/env python3
MIN_PYTHON_VERSION = (3, 8)
MAX_PYTHON_VERSION_TO_CONSIDER = (3, 20)

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


def object_directory(engine: Path) -> Path:
    mozconfig = Path(os.environ.get("MOZCONFIG") or engine / "mozconfig")
    declared = None
    if mozconfig.is_file():
        for match in re.finditer(
            r"^\\s*mk_add_options\\s+MOZ_OBJDIR\\s*=\\s*[\\"']?([^\\"'\\s#]+)",
            mozconfig.read_text(encoding="utf-8"),
            re.M,
        ):
            declared = match.group(1)
    if declared is None:
        return engine / "obj-fireforge"
    return Path(declared.replace("@TOPSRCDIR@", str(engine)))


def write_artifacts(engine: Path, state: Path, command: str, args: list) -> None:
    objdir = object_directory(engine)
    if command in ("configure", "build"):
        objdir.mkdir(parents=True, exist_ok=True)
        mozconfig = os.environ.get("MOZCONFIG") or str(engine / "mozconfig")
        (objdir / "mozinfo.json").write_text(
            json.dumps({"topsrcdir": str(engine), "topobjdir": str(objdir), "mozconfig": mozconfig})
            + "\\n",
            encoding="utf-8",
        )
        (objdir / "config.status").write_text(
            f"topsrcdir = {str(engine)!r}\\ntopobjdir = {str(objdir)!r}\\n", encoding="utf-8"
        )
    name_file = state / "binary-name"
    name = name_file.read_text(encoding="utf-8").strip() if name_file.exists() else "firefox"
    if command == "build":
        stamp = objdir / "dist" / "bin" / ".built"
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(json.dumps({"args": args}) + "\\n", encoding="utf-8")
        binaries = [objdir / "dist" / "bin" / (f"{name}.exe" if sys.platform == "win32" else name)]
        if sys.platform == "darwin":
            binaries.append(objdir / "dist" / "Synthetic.app" / "Contents" / "MacOS" / name)
        for binary in binaries:
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_text("#!/bin/sh\\nexit 0\\n", encoding="utf-8")
            binary.chmod(0o755)
    if command == "package":
        (objdir / "dist").mkdir(parents=True, exist_ok=True)
        (objdir / "dist" / f"{name}.package").write_text("package\\n", encoding="utf-8")


def main() -> int:
    engine = Path(__file__).resolve().parent
    state = engine / ".mach-state"
    # Lines end the same way on every host.
    sys.stdout.reconfigure(newline="\\n")
    sys.stderr.reconfigure(newline="\\n")
    args = sys.argv[1:]
    state.mkdir(parents=True, exist_ok=True)
    names = [name for name in os.environ if name.startswith("MOZ")]
    wanted = state / "record-env"
    if wanted.exists():
        names += wanted.read_text(encoding="utf-8").split()
    env = {name: os.environ[name] for name in sorted(set(names)) if name in os.environ}
    with (state / "commands.jsonl").open("a", encoding="utf-8", newline="\\n") as log:
        log.write(json.dumps({"args": args, "env": env}) + "\\n")
    if not args:
        print("No mach command provided", file=sys.stderr)
        return 2
    command = args[0]
    if (state / f"fail-{command}").exists():
        print(f"{command} failed", file=sys.stderr)
        return 1
    script_file = state / f"script-{command}.json"
    script = json.loads(script_file.read_text(encoding="utf-8")) if script_file.exists() else None
    by_arg = (script or {}).get("byArg") or {}
    script = next((by_arg[arg] for arg in args if arg in by_arg), script)
    if script is None or not script.get("noArtifacts"):
        write_artifacts(engine, state, command, args)
    if script is None:
        print(f"{command} complete")
        return 0
    raw_log = next((arg[len("--log-raw="):] for arg in args if arg.startswith("--log-raw=")), None)
    if raw_log is not None and "rawLog" in script:
        with open(raw_log, "w", encoding="utf-8", newline="\\n") as raw:
            raw.write("".join(json.dumps(record) + "\\n" for record in script["rawLog"]))
    if script.get("detach"):
        subprocess.Popen(
            script["detach"],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    for line in script.get("stdout", []):
        print(line, flush=True)
    for line in script.get("stderr", []):
        print(line, file=sys.stderr, flush=True)
    time.sleep(script.get("sleep", 0))
    return script.get("exit", 0)


if __name__ == "__main__":
    raise SystemExit(main())
`;

/** The smallest valid PNG: one transparent pixel. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

/** The files of the synthetic tree. */
export const SYNTHETIC_FIREFOX_FILES: FileTree = {
  '.gitignore': '.mach-state/\nobj-*/\n',
  mach: MACH_SCRIPT,
  'browser/moz.configure': 'imply_option("MOZ_APP_VENDOR", "Mozilla")\n',
  'browser/base/content/browser.js': 'export const browserTitle = "baseline";\n',
  'browser/base/jar.mn':
    'browser.jar:\n        content/browser/browser.js              (content/browser.js)\n',
  'browser/modules/moz.build': 'DIRS += ["newtab"]\n',
  'browser/branding/unofficial/moz.build': 'DIRS += ["content"]\n',
  'browser/branding/unofficial/default16.png': TINY_PNG,
  'browser/branding/unofficial/locales/en-US/brand.ftl':
    '-brand-shorter-name = Firefox\n-brand-short-name = Firefox\n-brand-full-name = Firefox\n',
  'toolkit/components/example/service.sys.mjs': 'export const version = 1;\n',
  'browser/base/moz.build':
    'BROWSER_CHROME_MANIFESTS += [\n    "content/test/about/browser.toml",\n]\n\nJAR_MANIFESTS += ["jar.mn"]\n',
  'toolkit/content/jar.mn': [
    'toolkit.jar:',
    '%  content global %content/global/ contentaccessible=yes',
    '   content/global/customElements.js',
    '   content/global/elements/findbar.js    (widgets/findbar.js)',
    '   content/global/elements/moz-card.css    (widgets/moz-card/moz-card.css)',
    '   content/global/elements/moz-card.mjs    (widgets/moz-card/moz-card.mjs)',
    '   content/global/elements/moz-toggle.mjs    (widgets/moz-toggle/moz-toggle.mjs)',
    '',
  ].join('\n'),
  'toolkit/content/customElements.js': `"use strict";

(() => {
  const loadExtraCustomElements = true;
  if (loadExtraCustomElements) {
    for (let [tag, script] of [
      ["findbar", "chrome://global/content/elements/findbar.js"],
      ["menulist", "chrome://global/content/elements/menulist.js"],
    ]) {
      customElements.setElementCreationCallback(tag, () => {
        Services.scriptloader.loadSubScript(script, window);
      });
    }

    let acornElements = [
      ["moz-card", "chrome://global/content/elements/moz-card.mjs"],
      [
        "moz-toggle",
        "chrome://global/content/elements/moz-toggle.mjs",
      ],
    ];

    document.addEventListener(
      "DOMContentLoaded",
      () => {
        for (let [tag, script] of acornElements) {
          customElements.setElementCreationCallback(tag, () => {
            ChromeUtils.importESModule(script, { global: "current" });
          });
        }
      },
      { once: true }
    );
  }
})();
`,
  'toolkit/content/widgets/moz-card/moz-card.mjs': `import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

export default class MozCard extends MozLitElement {
  render() {
    return html\`<link rel="stylesheet" href="chrome://global/content/elements/moz-card.css" /><slot></slot>\`;
  }
}
customElements.define("moz-card", MozCard);
`,
  'toolkit/content/widgets/moz-card/moz-card.css':
    ':host {\n  display: block;\n  color: var(--text-color);\n}\n',
};

/**
 * Writes the synthetic tree into a directory.
 *
 * @param directory - Where the tree goes
 * @param extra - Files to add or replace on top of the base tree
 */
export async function writeSyntheticFirefox(
  directory: string,
  extra: FileTree = {}
): Promise<void> {
  await writeTree(directory, { ...SYNTHETIC_FIREFOX_FILES, ...extra });
  await chmod(join(directory, 'mach'), 0o755);
}

/**
 * Scripts what the stand-in `mach` of a synthetic tree does for one command.
 *
 * @param engineDir - The synthetic tree
 * @param command - The mach command, such as `build`
 * @param script - See {@link MachScript}
 */
export async function scriptMach(
  engineDir: string,
  command: string,
  script: MachScript
): Promise<void> {
  await writeTree(engineDir, { [`.mach-state/script-${command}.json`]: JSON.stringify(script) });
}

/** One call the stand-in `mach` received. */
export interface MachCall {
  args: string[];
  /** The `MOZ*` variables it ran with, and those named in `.mach-state/record-env`. */
  env: Record<string, string>;
}

/**
 * The calls the stand-in `mach` of a synthetic tree has received, oldest first.
 *
 * @param engineDir - The synthetic tree
 */
export async function readMachLog(engineDir: string): Promise<MachCall[]> {
  let text: string;
  try {
    text = await readFile(join(engineDir, SYNTHETIC_FIREFOX_PATHS.machLog), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MachCall);
}

/**
 * Packs the synthetic tree the way Mozilla ships source: a `.tar.xz` whose
 * single top-level directory is `firefox-<version>`.
 *
 * @param workDir - Scratch directory the archive is created in
 * @param version - The Firefox version the archive claims
 * @param extra - Files to add or replace on top of the base tree
 * @returns The archive's path
 */
export async function makeSyntheticFirefoxArchive(
  workDir: string,
  version = '140.9.0esr',
  extra: FileTree = {}
): Promise<string> {
  const top = `firefox-${version}`;
  await writeSyntheticFirefox(join(workDir, 'archive-source', top), extra);
  const archive = join(workDir, `${top}.source.tar.xz`);
  await execFileAsync('tar', ['-cJf', archive, '-C', join(workDir, 'archive-source'), top]);
  return archive;
}
