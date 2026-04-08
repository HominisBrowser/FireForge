// SPDX-License-Identifier: EUPL-1.2
import { makeTarXzArchive } from './index.js';

export const SYNTHETIC_FIREFOX_PATHS = {
  browserScript: 'browser/base/content/browser.js',
  serviceScript: 'toolkit/components/example/service.sys.mjs',
  rustBuildScript: 'tools/profiler/rust-api/build.rs',
  mozbuild: 'browser/modules/moz.build',
  brandingPng: 'browser/branding/unofficial/default16.png',
  mozConfigure: 'browser/moz.configure',
  buildInfo: 'obj-fireforge/dist/build-info.json',
  machLog: '.mach-state/commands.jsonl',
} as const;

export { TINY_PNG };

const MACH_SCRIPT = `MIN_PYTHON_VERSION = (3, 8)
MAX_PYTHON_VERSION_TO_CONSIDER = (3, 12)

import json
import sys
from pathlib import Path


def append_log(state_dir: Path, args: list[str]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / "commands.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"args": args}) + "\\n")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main() -> int:
    engine_dir = Path(__file__).resolve().parent
    state_dir = engine_dir / ".mach-state"
    args = sys.argv[1:]

    append_log(state_dir, args)

    if not args:
        print("No mach command provided", file=sys.stderr)
        return 2

    if args[0] == "bootstrap":
        if (state_dir / "fail-bootstrap").exists():
            print("Traceback (most recent call last):", file=sys.stderr)
            print("HTTP Error 403: Forbidden", file=sys.stderr)
            return 1
        write_text(state_dir / "bootstrap-ok.txt", "bootstrap complete\\n")
        print("bootstrap complete")
        return 0

    if args[0] == "build":
        if (state_dir / "fail-build").exists():
            print("build failed", file=sys.stderr)
            return 1

        mozconfig_path = engine_dir / "mozconfig"
        moz_configure_path = engine_dir / "browser" / "moz.configure"
        branding_configure_path = (
            engine_dir / "browser" / "branding" / "mybrowser" / "configure.sh"
        )
        build_info = {
            "args": args,
            "mozconfigExists": mozconfig_path.exists(),
            "brandingConfigured": branding_configure_path.exists(),
            "vendorLinePatched": (
                'imply_option("MOZ_APP_VENDOR", "My Company")'
                in moz_configure_path.read_text(encoding="utf-8")
            ),
        }
        write_text(
            engine_dir / "obj-fireforge" / "dist" / "build-info.json",
            json.dumps(build_info, indent=2) + "\\n",
        )
        print("build complete")
        return 0

    if args[0] == "run":
        print("run " + " ".join(args[1:]))
        return 0

    if args[0] == "test":
        print("test " + " ".join(args[1:]))
        return 0

    if args[0] == "watch":
        print("watch mode not implemented", file=sys.stderr)
        return 130

    if args[0] == "package":
        print("package complete")
        return 0

    print(f"Unsupported synthetic mach command: {' '.join(args)}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
`;

// 1x1 transparent PNG (smallest valid PNG file, 68 bytes)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

const SYNTHETIC_FIREFOX_FILES: Record<string, string | Buffer> = {
  '.gitignore': '.mach-state/\nobj-fireforge/\n',
  mach: MACH_SCRIPT,
  'browser/moz.configure': 'imply_option("MOZ_APP_VENDOR", "Mozilla")\n',
  'browser/branding/unofficial/locales/en-US/brand.properties':
    'brandShorterName=Firefox\nbrandShortName=Firefox\nbrandFullName=Firefox\n',
  'browser/branding/unofficial/locales/en-US/brand.ftl':
    '-brand-shorter-name = Firefox\n-brand-short-name = Firefox\n-brand-full-name = Firefox\n-vendor-short-name = Mozilla\n',
  'browser/base/content/browser.js': 'export const browserTitle = "baseline";\n',
  'browser/modules/moz.build': 'DIRS += ["newtab"]\n',
  'toolkit/components/example/service.sys.mjs': 'export const version = 1;\n',
  'tools/profiler/rust-api/build.rs': [
    'use std::fs;',
    '',
    'fn generate_bindings() {',
    '    let out_file = "bindings.rs";',
    '    fs::write(out_file, "// generated").expect("write failed");',
    '}',
    '',
    'fn main() {',
    '    generate_bindings();',
    '}',
    '',
  ].join('\n'),
  'browser/branding/unofficial/default16.png': TINY_PNG,
};

/** Creates a synthetic Firefox source archive for integration tests. */
export async function makeSyntheticFirefoxArchive(
  root: string,
  version: string = '140.0esr'
): Promise<string> {
  return makeTarXzArchive(
    root,
    'synthetic-firefox.tar.xz',
    `firefox-${version}`,
    SYNTHETIC_FIREFOX_FILES
  );
}
