# FireForge

[![npm version](https://img.shields.io/npm/v/@hominis/fireforge)](https://www.npmjs.com/package/@hominis/fireforge)
[![license](https://img.shields.io/npm/l/@hominis/fireforge)](LICENSE.md)
[![node](https://img.shields.io/node/v/@hominis/fireforge)](package.json)

FireForge is a CLI tool for maintaining Firefox-based browser forks. It downloads Firefoxs source code, lets you export changes as patches, helps apply them and has some neat/mad code quality enforcement, built by taking a lot of learnings from the existing Firefox source code and trying to make the process as robust as can be. Ideally, FireForge makes everything from managing custom UI components to enforcing some rudimentary typechecking much easier, but I'll be honest, there is only so much one can do, so understanding upstream is advised, especially once future updates come into the mix. I cannot guarantee how reliably these will apply, but I did try to assist in that process as much as I can by learning from prior Firefox versions which had major changes made to them, though this is of course still no guarantee for future success or that the methods will remain reliable. Beware of that.

Inspired by [fern.js](https://github.com/ghostery/user-agent-desktop) and [Melon](https://github.com/dothq/melon).

## What It Does

- **Patch based** Edit Firefox inside the `engine/` directory, then export changes into `.patch` files with manifest metadata.
- **Source rebasing** Reapply your patches onto newer Firefox source trees, including ESR, Beta, and Developer Edition archives, resolve rejects and re-export the queue against the new baseline, hopefully...
- **Firefox source and build helpers** Download, bootstrap, build, run, test, package, smoke-check, etc.
- **Wiring and registration** Add chrome scripts, DOM fragments, modules, styles, tests and manifest entries through commands built by learning from existing Firefox conventions.
- **Furnace components** Create or override `MozLitElement` widgets easily to add new or adapt existing UI components to your needs.
- **Quality** `lint`, `typecheck`, `verify` and `doctor` catch common issues early.
- **Tests** Fireforge was build by taking apart and applying patches of all sorts to original Firefox source code across different versions and products, learning what works vs doesn't and creating some quite extensive tests based on that covering all manner of scenarios. Yes, we mock quite a bit, but when building a tool that modifies a separate code base, I think it's a solid compromise for the time being. Full end-to-end runs are currently run locally on my MacBook, as they require about 30 GB of disk and significant compute for multiple full builds. Full end-to-end via Actions will be added soonishlyTM but might need a different runner...

## Requirements

- Node.js 22.22.1+
- Python 3
- Git
- The normal Firefox platform build tools: Xcode command line tools on macOS, `build-essential`-style packages on Linux, Visual Studio Build Tools on Windows (never tested on Windows tbh)
- Watchman, if you want `fireforge watch` (optional)

## Getting Started

Create a project and install FireForge locally:

```bash
mkdir mybrowser && cd mybrowser
npm init -y
npm install --save-dev @hominis/fireforge
```

Then initialise and build:

```bash
npx fireforge setup
npx fireforge download
npx fireforge bootstrap
npx fireforge import
npx fireforge build
npx fireforge run
```

After setup you should have a `fireforge.json`, an `engine/` directory containing Firefox source and a `patches/` directory containing the patch manifest. From there, the usual loop is to change code inside the `engine/` directory, export these changes, then verify the queue still applies cleanly.

## Regular Workflow

```bash
npx fireforge status
npx fireforge export browser/base/content/browser.js --name custom-toolbar --category ui
npx fireforge re-export custom-toolbar
npx fireforge re-export --scan --scan-files generated-assets.json --dry-run
npx fireforge lint --per-patch
npx fireforge lint --per-patch --max-warnings 0
npx fireforge verify
npm run whitespace:check
npx fireforge build
npx fireforge test browser/base/content/test/browser/
```

Use `fireforge --help` for the full set of commands.

For large generated asset batches, `re-export --scan --scan-files <manifest>` assigns files to
their owner patches without broad directory scanning. The manifest is JSON:

```json
{
  "assignments": [
    { "patch": "002-branding-runtime-icons.patch", "files": ["browser/branding/hominis/icon.svg"] }
  ]
}
```

The command is dry-runnable, refuses ambiguous ownership, and reports each file-to-patch
assignment before refreshing the patch. For release whitespace checks, use
`npm run whitespace:check`; it still checks source diffs while excluding generated
`patches/*.patch` diff syntax.

Queue maintenance lives under `fireforge patch`: `patch compact` closes ordinal gaps
(range-aware when `patchPolicy.ranges` is configured), `patch reorder` moves a patch, and
`patch split <source> --files <paths...> --name <name>` carves files out of a patch into a
new one as a single transaction — including staged-dependency owner rewrites — with
`--dry-run` support.

`fireforge test` runs multiple test paths as sequential per-file shards by default
(`--no-shard` restores one combined invocation), retries recognized harness crashes up to
`--harness-retries <n>` times (default 2), and can publish a perf-sample artifact path to
the harness via `--perf-samples <path>` (exported as `<BINARYNAME>_PERF_SAMPLE_JSON`).
Design tokens are managed with `fireforge token add`; pass `--create-category` to declare a
new category banner and insert the token in one step.

## Rebasing Firefox Source

When Mozilla publishes a new Firefox source release you need to update the configured version/product, download the new source code and reapply the patches:

```bash
npx fireforge source set --version 145.0.0esr --product firefox-esr --sha256 <archive-sha256>
npx fireforge download --force
npx fireforge rebase
```

If a patch fails, fix the reject inside the `engine/` directory, then run `npx fireforge rebase --continue`.

## Furnace

Furnace is our solution for UI components. It can track stock widgets, create new fork-owned widgets and override existing ones. The files still land inside the Firefox source directory and end up as part of the regular patches to export.

```bash
npx fireforge furnace scan
npx fireforge furnace override moz-button -t css-only
npx fireforge furnace create moz-my-widget
npx fireforge furnace deploy
npx fireforge furnace status
npx fireforge furnace preview
```

Use `fireforge furnace --help` for the full set of component commands.

Cross-widget CSS can be single-sourced as shared fragments: place the fragment in
`components/shared/` and reference it from a widget stylesheet with a
`/* @fireforge-include <fragment>.css */` comment — deploy expands it into the deployed
copy only, and editing the fragment surfaces as component drift until the next deploy.
For typed cross-module imports of multi-file components, set
`furnace.json#typecheckJsconfig` to a consumer-owned jsconfig and deploy will maintain
`compilerOptions.paths` entries mapping each deployed
`chrome://global/content/elements/<file>.mjs` URL to its workspace source.

## Roadmap

- **Docker builds** Reproducible builds using Docker containers.
- **CI mode** Automated setup for continuous integration pipelines.
- **Update manifests** Generate update server manifests for auto-updates.
- **Nightly source support** Requires implementing `hg clone` support via mozilla-central. ESR, Beta, and Developer Edition source archives are supported through `fireforge source set`.
- **E2E Github Actions** Requires either a higher tier of Githubs offering, an external VPS or another provider entirely. In any case, full end-to-end testing is currently run solely locally.

## Licence

FireForge is licensed under [EUPL-1.2](LICENSE.md).

Firefox source downloaded into `engine/` is licensed under [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) and is not distributed by this repository. Firefox-derived files created through Furnace keep MPL-2.0 headers, regardless of the licence you choose for your own project files during `fireforge setup`.
