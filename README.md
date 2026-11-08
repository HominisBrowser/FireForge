# FireForge

[![npm version](https://img.shields.io/npm/v/@hominis/fireforge)](https://www.npmjs.com/package/@hominis/fireforge)
[![license](https://img.shields.io/npm/l/@hominis/fireforge)](LICENSE.md)
[![node](https://img.shields.io/node/v/@hominis/fireforge)](package.json)

FireForge is a CLI tool for maintaining Firefox-based browser forks. It downloads Firefoxs source code, ~~lets you export changes as patches, helps apply them~~ keeps your changes as ordinary source in Git, builds and tests said changes in their own separate slots, writes patches whenever you need that feature (and still supports the old patch-based workflow) and has some neat and/or mad code quality enforcement, built by taking a lot of learnings from modifying the existing Firefox source code and trying to make the process as robust as can be. Ideally, FireForge makes everything from managing custom UI components to enforcing some rudimentary typechecking much easier, but I'll be honest, there is only so much one can do, so understanding upstream is advised, especially once future updates come into the mix. Thankfully, the Firefox team did create some great docs. ~~I cannot guarantee how reliably these will apply, but I did try to assist in that process as much as I can by learning from prior Firefox versions which had major changes made to them, though this is of course still no guarantee for future success or that the methods will remain reliable. Beware of that.~~ Edit 16.07.2026: I have now upgraded and downgraded and sidegraded, really all the graded, across all the versions in many scenarios with modifications so far removed from upstream that I think it's fair to say upgrading is fairly reliable.

Edit 08.11.2026: Source mode is now the standard way to use FireForge with patch-based development still being an option but not adviced. It works, is reliable and easy to understand (export diffs, apply to engine), but simply doesn't scale for parallel work. With source mode, changes now live as plain files under `src/`, every build and test runs as a job in its own cloned slot, and `fireforge prove` tells you what something still needs before it can land. Patches can still be used in conjuction with source mode, by the way, FireForge generates them from your source whenever you want an easier format to publish, hand to CI or roll back to.

Original patch mode was inspired by [fern.js](https://github.com/ghostery/user-agent-desktop) and [Melon](https://github.com/dothq/melon).

## What It Does

- **Source mode** Keep your changes as ordinary tracked files in Git. Edit them in any checkout or `git worktree`, run builds and tests as jobs in their own separate slots and let `prove` work out what a change still needs.
- **Patch mode** Edit inside `engine/` and export `.patch` files with manifest metadata. In source mode the patches are generated from your source (`authored export-queue`), one per component, so you can publish a readable queue, let CI import or roll back to the queue workflow.
- **Source rebasing** `authored refresh` three-way merges your source onto the new pin and hands you only the real conflicts. Patch mode still rebases the queue the old way.
- **Firefox source and build helpers** Download, bootstrap, build, run, test, package, smoke-check, etc.
- **Wiring and registration** Add chrome scripts, DOM fragments, modules, styles, tests and manifest entries through commands built by learning from existing Firefox conventions.
- **Furnace components** Create or override `MozLitElement` widgets easily to add new or adapt existing UI components to your needs.
- **Quality** `lint`, `typecheck`, `verify` and `doctor` catch common issues early, and `check` runs the static gates together with one verdict.
- **Tests** FireForge was built by taking apart and applying patches of all sorts to original Firefox source code across different versions and products, learning what works vs doesn't and creating some quite extensive tests based on that covering all manner of scenarios. Yes, we mock quite a bit, but when building a tool that modifies a separate code base, I think it's a solid compromise for the time being. Full end-to-end runs are currently run locally on my MacBook, as they require about 30 GB of disk and significant compute for multiple full builds. Full end-to-end via Actions will be added soonishlyTM but might need a different runner...

## Requirements

- Node.js 22.22.2+
- Python 3
- Git
- The normal Firefox platform build tools: Xcode command line tools on macOS, `build-essential`-style packages on Linux, Visual Studio Build Tools on Windows.
- Watchman, if you want `fireforge watch` (optional)

## Getting Started

Create a project and install FireForge locally:

```bash
mkdir mybrowser && cd mybrowser
npm init -y
npm install --save-dev @hominis/fireforge
```

Then initialise and build once:

```bash
npx fireforge setup
npx fireforge download
npx fireforge bootstrap
npx fireforge import
npx fireforge build
npx fireforge run
```

After setup you should have a `fireforge.json`, an `engine/` directory containing Firefox source and a `patches/` directory containing the patch manifest. That is a patch mode project, which is where every project starts. To switch it to source mode, migrate via the following commands:

```bash
npx fireforge authored migrate --out ../migration --verify
# merge fireforge.fragment.json into fireforge.json, copy src/ and .fireforge-sources/ in, remove patches/
npx fireforge authored merge-install
npx fireforge host init --slots 2 --from-engine ./engine
```

## Source Mode Workflow

The new workflow for parallel work.

```bash
npx fireforge authored override browser/themes/shared/tabs.css   # first edit of an upstream file
$EDITOR src/browser/themes/shared/tabs.css
npx fireforge authored lint                                       # quick static feedback, no slot needed
npx fireforge job run --test browser/themes/test/browser_tabs.js  # build what changed, run the test in a slot
npx fireforge prove                                               # what this change needs, and whether it has it
npx fireforge prove --tier gate && npx fireforge prove publish    # before you push
```

## Patch Mode Workflow

The original patch-based workflow that I fell in love with but had to accept was not scalable is retained. In a source mode project its commands (`export`, `import`, `build`, `test` and friends) refuse and tell you what to use instead.

```bash
npx fireforge status
npx fireforge export browser/base/content/browser.js --name custom-toolbar --category ui
npx fireforge re-export custom-toolbar
npx fireforge lint --per-patch
npx fireforge verify
npx fireforge build
npx fireforge test browser/base/content/test/browser/
```

## Rebasing Firefox Source

When Mozilla publishes a new Firefox release, source mode fetches the new pristine tree and proposes a merge you review before adopting it:

```bash
npx fireforge authored pristine fetch --out ~/.fireforge/pristine/next --pin new-pin.json
npx fireforge authored refresh --snapshot old.json --pristine-repository <old pristine> \
  --new-pristine-repository ~/.fireforge/pristine/next --new-pin new-pin.json --out ../refresh
```

In patch mode you update the configured version/product, download the new source code and reapply the patches:

```bash
npx fireforge source set --version 145.0.0esr --product firefox-esr --sha256 <archive-sha256>
npx fireforge download --force
npx fireforge rebase
```

If a patch fails, fix the reject inside the `engine/` directory, then run `npx fireforge rebase --continue`.

## Furnace

Furnace is our solution for UI components. It can track stock widgets, create new fork-owned widgets and override existing ones. Component sources stay under `components/`, in source mode they are composed into each sessions engine and in patch mode they land inside the Firefox source directory and subseqeuntly are exported as part of your patches.

```bash
npx fireforge furnace scan
npx fireforge furnace override moz-button -t css-only
npx fireforge furnace create moz-my-widget
npx fireforge furnace deploy
npx fireforge furnace status
npx fireforge furnace preview
```

In source mode `deploy` happens inside jobs and `furnace types` keeps the generated typecheck files in your checkout current. Use `fireforge furnace --help` for the full set of component commands, and [`docs/furnace.md`](docs/furnace.md) for shared CSS fragments and typed cross-module imports.

## Documentation

[`docs/`](docs/README.md) holds the reference material:

- [Authored sources](docs/authored-sources.md) — source mode: overrides, capture, migration, exporting a queue, refreshing the pin
- [Jobs and slots](docs/jobs-and-slots.md) — `host init`, `job run`, slots, capacity and recovery
- [Proof](docs/proof.md) — `prove`: obligations, evidence, accept and waive, the verified ref
- [Patch workflow](docs/patch-workflow.md) — export, re-export, queue maintenance, per-patch lint, CI gating
- [Testing](docs/testing.md) — `fireforge test` scope, modes, build freshness, the verdict line
- [Furnace](docs/furnace.md) — components, shared CSS fragments, typed imports
- [Verification trees](docs/verification-trees.md) — CoW snapshots for concurrent verification
- [Configuration](docs/configuration.md) — `fireforge.json`, design tokens, lock waits, environment variables
- [Exit codes](docs/exit-codes.md) and [machine-readable output](docs/machine-output.md) — the contract for scripts and CI
- [Run logs](docs/run-logs.md) — what `test` and `build` leave behind
- [Lifecycle invariants](contributing/lifecycle-invariants.md) — locking, rollback and signal handling internals

## Roadmap

- **Docker builds** Reproducible builds using Docker containers.
- **CI mode** Automated setup for continuous integration pipelines.
- **Update manifests** Generate update server manifests for auto-updates.
- **Nightly source support** Requires implementing `hg clone` support via mozilla-central. ESR, Beta, and Developer Edition source archives are supported through `fireforge source set`.
- **E2E Github Actions** Requires either a higher tier of Githubs offering, an external VPS or another provider entirely. In any case, full end-to-end testing is currently run solely locally.
- **Remote workers** Slots on other machines, so jobs can run where the cores are.

## Licence

FireForge is licensed under [EUPL-1.2](LICENSE.md).

Firefox source downloaded into `engine/` is licensed under [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) and is not distributed by this repository. Firefox-derived files created through Furnace keep MPL-2.0 headers, regardless of the licence you choose for your own project files during `fireforge setup`.
