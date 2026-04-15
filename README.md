# FireForge

[![npm version](https://img.shields.io/npm/v/@hominis/fireforge)](https://www.npmjs.com/package/@hominis/fireforge)
[![license](https://img.shields.io/npm/l/@hominis/fireforge)](LICENSE.md)
[![node](https://img.shields.io/node/v/@hominis/fireforge)](package.json)
[![types](https://img.shields.io/npm/types/@hominis/fireforge)](https://www.npmjs.com/package/@hominis/fireforge)
[![npm downloads](https://img.shields.io/npm/dm/@hominis/fireforge)](https://www.npmjs.com/package/@hominis/fireforge)

**Build and maintain your own Firefox-based browser with a patch-first workflow**

FireForge gives you a toolkit for forking Firefox: download a specific ESR release, manage your customisations as a series of patches, survive version upgrades with semi-automated rebase, wire custom code into Mozilla's startup paths and build the result. It also ships **Furnace**, a component system for creating and overriding Firefox custom elements under `toolkit/content/widgets`.

Inspired by [fern.js](https://github.com/ghostery/user-agent-desktop) and [Melon](https://github.com/dothq/melon).

## Features

- **Patch-based fork management** Your customisations live as portable, ordered `.patch` files. Export single files, multiple paths, or everything at once. Contextual diffs mean upstream security fixes are not silently dropped when you rebase.

- **Semi-automated ESR rebase** `fireforge rebase` replays your patch stack onto new Firefox source with escalating fuzz matching. When a patch fails, you fix it manually and `--continue`. The full stack gets re-exported with updated version stamps.

- **Wiring and registration** `fireforge wire` and `fireforge register` inject your code into Mozilla's startup paths, build manifests and JAR files with a single command. The injection is AST-based (via Acorn), so it survives formatting changes applied between versions.

- **Furnace component system** Override existing Firefox custom elements or create new ones under `toolkit/content/widgets` (CSS-only restyles, full behavioural forks, or entirely new widgets).

- **Design token management** Track CSS custom property coverage across your modified files.

- **Quality checks** `fireforge lint` catches fork-specific issues (raw colours, missing licence headers, relative imports, large patches, cross-patch ordering problems) before you export. `fireforge verify` runs a read-only integrity check over the whole patch queue. `fireforge doctor` diagnoses project health including Furnace component validation.

- **Built and validated against real Firefox code** Developed by editing a real Firefox ESR codebase, learning from existing patch tools, observing the breakages and edge cases that surfaced and turning those findings into a realistic test suite. In-repo tests are thus grounded in actual development scenarios. Yes, we mock quite a bit, but when building a tool that modifies a separate code base, I think it's a solid compromise for the time being. Full end-to-end runs are currently run locally, as they require about 30 GB of disk and significant compute for multiple full builds. Full end-to-end via Github Actions will be added soonishlyTM.

## Quick Start

### Requirements

- **Node.js 20+**
- **Python 3** (required by Firefox's `mach` build system).
- **Git**
- Platform build tools: Xcode on macOS, `build-essential` on Linux, Visual Studio Build Tools on Windows.

### Setup

```bash
mkdir mybrowser && cd mybrowser
npm init -y
npm install --save-dev @hominis/fireforge

npx fireforge setup              # interactive project init
npx fireforge download            # fetch Firefox source (~1 GB)
npx fireforge bootstrap           # install build deps (may need sudo)
npx fireforge import              # apply your patches (if any exist)
npx fireforge build               # build the browser
npx fireforge run                 # launch it
```

Your project now has `fireforge.json`, an `engine/` directory with Firefox source and a `patches/` directory with an empty `patches.json` manifest ready for your first customisation.

### Workflow Overview

```bash
# 1. Make changes inside engine/
#    Edit browser/base/content/browser.js, add CSS, create new modules...

# 2. Export your changes as a patch
npx fireforge export browser/base/content/browser.js \
  --name "custom-toolbar" --category ui

# 3. Your patch is now in patches/001-ui-custom-toolbar.patch
#    with metadata tracked in patches/patches.json

# 4. Later, reset and replay to verify everything applies cleanly
npx fireforge reset --yes
npx fireforge import              # --dry-run to preview without applying

# 5. When Firefox releases a new ESR, update fireforge.json, re-download and rebase
npx fireforge download --force
npx fireforge rebase
```

## Patch Workflow

Patches live in `patches/`, applied by numeric filename prefix and tracked in `patches/patches.json`:

```
patches/
  001-branding-custom-logo.patch
  002-privacy-disable-telemetry.patch
  003-ui-sidebar-tweaks.patch
  patches.json
```

**Categories:** `branding` | `ui` | `privacy` | `security` | `infra`

The category system is intentionally broad. The numeric ordering provides sequencing.

### Importing patches

```bash
# Apply all patches from patches/ to the engine
fireforge import

# Preview what would be applied without modifying the engine
fireforge import --dry-run

# Apply patches up to (and including) a specific one
fireforge import --until 003-ui-sidebar-tweaks.patch

# Keep going if a patch fails instead of stopping
fireforge import --continue

# Force-apply even when the engine has drifted or has unmanaged changes
fireforge import --force
```

### Exporting changes

```bash
# Single file
fireforge export browser/base/content/browser.js

# Multiple paths with metadata
fireforge export browser/modules/mybrowser/*.sys.mjs \
  --name "storage-infra" --category infra

# Everything at once
fireforge export-all --name "all-changes" --category ui

# Regenerate patches after further edits
fireforge re-export --all --scan

# Preview what an export would do without writing
fireforge export browser/base/content/browser.js --dry-run

# Insert a new patch at a specific position
fireforge export browser/base/content/browser.js --order 3 --name "inserted" --category ui
fireforge export browser/base/content/browser.js --before 005-ui-sidebar.patch --name "prelim"

# Restrict a re-export to a specific file subset
fireforge re-export --files browser/base/content/browser.js 002-ui-toolbar
```

### Rebasing on top of a new Firefox version

1. Update `firefox.version` in `fireforge.json`
2. `fireforge download --force`
3. `fireforge rebase`
4. Fix any rejects, then `fireforge rebase --continue`
5. If stuck, `fireforge rebase --abort` to restore the pre-rebase state

### Resolving conflicts

When `fireforge import` fails on a patch, fix the `.rej` files in `engine/`, then:

```bash
fireforge resolve
```

This re-exports the fixed patch and continues applying the remaining stack.

<details>
<summary>Patch manifest format</summary>

`patches/patches.json` is updated automatically by `export` and `re-export`:

```json
{
  "version": 1,
  "patches": [
    {
      "filename": "001-branding-custom-logo.patch",
      "order": 1,
      "category": "branding",
      "name": "custom-logo",
      "description": "Replaces default Firefox branding with custom logo",
      "createdAt": "2025-01-15T10:30:00Z",
      "sourceEsrVersion": "140.9.0esr",
      "filesAffected": ["browser/branding/official/logo.png"]
    }
  ]
}
```

If the manifest drifts after an interrupted export or manual edits, `fireforge import` will stop rather then silently applying a stale stack. Use `fireforge doctor --repair-patches-manifest` to rebuild it from disk. Because the rebuild is deterministic, the result will always be consistent with what is actually on the filesystem.

</details>

<details>
<summary>Patch lint checks</summary>

`fireforge lint` runs automatically during export, export-all and re-export. Use `--skip-lint` to downgrade errors to warnings. Errors block the export; warnings are printed but do not block.

| Check                          | Scope                                 | Severity |
| ------------------------------ | ------------------------------------- | -------- |
| `missing-license-header`       | New files (JS/CSS/FTL)                | error    |
| `relative-import`              | JS/MJS files                          | error    |
| `token-prefix-violation`       | CSS files (with furnace)              | error    |
| `raw-color-value`              | Introduced CSS color values           | error    |
| `duplicate-new-file-creation`  | Same path created by multiple patches | error    |
| `forward-import`               | Patch imports from a later-patch file | error    |
| `missing-jsdoc`                | Exports in patch-owned `.sys.mjs`     | error    |
| `jsdoc-param-mismatch`         | Exports in patch-owned `.sys.mjs`     | error    |
| `jsdoc-missing-returns`        | Exports in patch-owned `.sys.mjs`     | error    |
| `checkjs-type-error`           | Patch-owned `.sys.mjs` (opt-in)       | error    |
| `missing-modification-comment` | Modified upstream JS/MJS              | warning  |
| `modified-file-missing-header` | Modified upstream files (JS/CSS/FTL)  | warning  |
| `file-too-large`               | New files >650 lines                  | warning  |
| `observer-topic-naming`        | Observer topics with binaryName       | warning  |
| `large-patch-files`            | Patches affecting >5 files            | warning  |
| `large-patch-lines`            | Patches >300 lines                    | warning  |

**JSDoc validation** uses AST-based analysis (Acorn) to validate exported APIs in patch-owned `.sys.mjs` files. A file is "patch-owned" if it was newly created by the current diff or by an existing patch in the queue. Functions must document every `@param` (names must match) and include `@returns` when the function returns a value. Exported constants and classes require a JSDoc block.

**Optional `checkJs` pass.** Enable a TypeScript-esque bastardization of type checking for patch-owned `.sys.mjs` files by adding `"patchLint": { "checkJs": true }` to `fireforge.json`. This uses the TypeScript compiler API with `allowJs + checkJs + noEmit`, scoped only to patch-owned files. Firefox globals (`Services`, `ChromeUtils`, `lazy`, etc.) are shimmed automatically. Module-resolution errors from Firefox's `resource://` and `chrome://` URL schemes are suppressed since TypeScript cannot follow these. This pass solely focuses on type errors within the patch-owned code itself (mismatched JSDoc types, wrong argument counts, unreachable code, etc.).

The two cross-patch rules (`duplicate-new-file-creation` and `forward-import`) run over the whole patch queue rather than a single diff, catching ordering issues that only surface during `import`. Forward-import detection compares leaf filenames, so a false positive is theoretically possible when two patches create files with the same basename in different directories. Suppress with an inline `// fireforge-ignore: forward-import` comment on or above the import line. This is currently the only lint rule that supports inline suppression.

</details>

### Repairing a broken patch queue

When a patch queue drifts, e.g. due to overlapping new-file creations, forward imports, manifest desync, etc. start with diagnosing the root cause:

```bash
fireforge verify                    # fsck: manifest + cross-patch lint
fireforge lint                      # includes the same cross-patch rules
fireforge status --ownership        # flat path → owning patch table
fireforge status --json             # machine-readable classified output
```

Then fix with the appropriate primitive:

| Problem                                        | Fix                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Two patches each creating the same file        | `fireforge patch delete <duplicate>` or `fireforge re-export --files` |
| A patch imports from a module in a later patch | `fireforge patch reorder <later> --before <importer>`                 |
| Wrong patch ordering                           | `fireforge patch reorder <patch> --to <N>`                            |
| A patch claims files that belong elsewhere     | `fireforge re-export --files <subset> <patch>`                        |
| Manifest references a missing patch file       | `fireforge doctor --repair-patches-manifest`                          |
| Unmanaged changes you want to discard          | `fireforge discard <file>` or `fireforge reset`                       |

Every destructive command defaults to an interactive confirmation with a change summary. `--dry-run` previews without writing; `--yes` skips the prompt for CI; `--force-unsafe` bypasses structural refusals when you have context the linter cannot see. Do not hand-edit `patches.json` as the file is owned by FireForge.

## Wiring Custom Code

```bash
# Wire a subscript with init/destroy lifecycle
fireforge wire my-widget --init "MyWidget.init()" --destroy "MyWidget.destroy()"

# Register a file in the correct build manifest
fireforge register browser/modules/mybrowser/MyStore.sys.mjs

# Both support --dry-run to preview changes
```

<details>
<summary>Wire options</summary>

- **Subscript** (always): Adds `loadSubScript` call to `browser-main.js`
- **`--init <expr>`**: Adds init expression to `gBrowserInit.onLoad()` in `browser-init.js`
- **`--destroy <expr>`**: Adds destroy expression to `onUnload()` (LIFO ordering, which matters because destroy handlers that run in the wrong order can leave dangling references)
- **`--after <name>`**: Controls ordering between dependent subscripts
- **`--dom <file>`**: Inserts `#include` directive for `.inc.xhtml` into `browser.xhtml`
- **`--subscript-dir <dir>`**: Override the subscript directory (default: `browser/base/content`)

</details>

<details>
<summary>Supported register patterns</summary>

| File pattern                               | Manifest                              | Entry format                        |
| ------------------------------------------ | ------------------------------------- | ----------------------------------- |
| `browser/themes/shared/*.css`              | `browser/themes/shared/jar.inc.mn`    | `skin/classic/browser/{name}.css`   |
| `browser/base/content/*.{js,mjs}`          | `browser/base/jar.mn`                 | `content/browser/{file}`            |
| `browser/base/content/test/*/browser.toml` | `browser/base/moz.build`              | `"content/test/{dir}/browser.toml"` |
| `browser/modules/mybrowser/*.sys.mjs`      | `browser/modules/mybrowser/moz.build` | `"{name}.sys.mjs"`                  |
| `toolkit/content/widgets/*/*.{mjs,css}`    | `toolkit/content/jar.mn`              | `content/global/elements/{file}`    |

</details>

## Furnace (UI Component System)

Furnace manages Firefox custom elements (`MozLitElement`) under `toolkit/content/widgets`. You can override existing components or create new ones. Changes feed into the same patch workflow as everything else, Furnace is not a separate persistence layer.

There are three component types:

| Type         | What it is                                             | Local files                    |
| ------------ | ------------------------------------------------------ | ------------------------------ |
| **Stock**    | Engine components tracked for Storybook preview        | None                           |
| **Override** | Forked copy: `css-only` (restyle) or `full` (JS + CSS) | `components/overrides/<name>/` |
| **Custom**   | New element that does not exist in Firefox             | `components/custom/<name>/`    |

```bash
fireforge furnace scan                             # discover components in the engine
fireforge furnace override moz-button -t css-only  # fork with CSS-only restyle
fireforge furnace create moz-my-widget             # scaffold a new component
fireforge furnace deploy                           # apply to engine/ + validate
fireforge furnace status                           # workspace vs engine drift
fireforge furnace diff moz-button                  # unified diff against baseline
```

`furnace deploy` validates components before applying. As always, errors block, warnings are advisory. `fireforge build` and `fireforge test --build` run apply automatically. Use `fireforge doctor --repair-furnace` if the engine gets out of sync.

## Additional Commands

The commands below cover project configuration, patch queue management, build packaging and development utilities. Run `fireforge <command> --help` for full option details.

### Configuration

```bash
# Read a config value
fireforge config firefox.version

# Set a config value
fireforge config firefox.version 145.0.0esr

# Set a value at a non-standard path (requires --force)
fireforge config customKey "value" --force
```

### Patch queue management

```bash
# Delete a patch from the queue
fireforge patch delete 003-ui-sidebar-tweaks.patch

# Reorder a patch to a new position
fireforge patch reorder 003-ui-sidebar-tweaks.patch --to 1

# Move a patch before or after another
fireforge patch reorder 003-ui-sidebar.patch --before 001-branding-logo.patch
```

Both subcommands support `--dry-run` and `--yes`.

### Additional workflow commands

```bash
# Package the built browser for distribution
fireforge package

# Watch for file changes and auto-rebuild
fireforge watch

# Add a CSS design token
fireforge token --name "--my-color" --value "light-dark(#fff, #000)"
```

## Configuration

`fireforge.json` at your project root:

```json
{
  "name": "MyBrowser",
  "vendor": "My Company",
  "appId": "org.example.mybrowser",
  "binaryName": "mybrowser",
  "license": "EUPL-1.2",
  "firefox": {
    "version": "140.9.0esr",
    "product": "firefox-esr"
  },
  "build": { "jobs": 8 },
  "wire": { "subscriptDir": "browser/components/mybrowser" }
}
```

## Roadmap

Planned but not yet implemented:

- **Docker builds** Reproducible builds using Docker containers.
- **CI mode** Automated setup for continuous integration pipelines.
- **Update manifests** Generate update server manifests for auto-updates.
- **Nightly support** Requires implementing `hg clone` support via mozilla-central. Currently fireforge only downloads from the archive.
- **E2E Github Actions** Requires either a higher tier of Github offering, an external VPS or similar, or another provider entirely. In either case, full end-to-end testing is currently run solely locally.

## Licence

[EUPL-1.2](LICENSE.md). Firefox source in `engine/` is under [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) and is not distributed by this repository.

During `fireforge setup`, you choose a licence for your project files. Options: EUPL-1.2 (default), MPL-2.0, 0BSD, GPL-2.0-or-later. Firefox-derived files from Furnace always carry MPL-2.0 headers, because that is what the upstream licence requires regardless of your project-level choice.
