# FireForge

[![CI](https://github.com/topfi/fireforge/actions/workflows/ci.yml/badge.svg)](https://github.com/topfi/fireforge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/fireforge)](https://www.npmjs.com/package/fireforge)
[![Node.js](https://img.shields.io/node/v/fireforge)](https://nodejs.org/)
[![License: EUPL-1.2](https://img.shields.io/badge/license-EUPL--1.2-blue)](LICENSE.md)

**Build and maintain your own Firefox-based browser with a patch-first workflow.**

FireForge gives you a complete toolkit for forking Firefox: download a specific ESR release, manage your customizations as an ordered stack of contextual patches, survive version upgrades with semi-automated rebase, wire custom code into Mozilla's startup paths, and build/package the result. It also ships **Furnace**, a component system for creating and overriding Firefox custom elements.

Inspired by [fern.js](https://github.com/nicktrosper/user-agent-desktop?tab=readme-ov-file#user-agent-desktop) and [Melon](https://github.com/nicktrosper/nicktrosper-melon).

---

## Quick Start

```bash
mkdir mybrowser && cd mybrowser
npm init -y
npm install --save-dev fireforge

npx fireforge setup              # interactive project init
npx fireforge download            # fetch Firefox source (~1 GB)
npx fireforge bootstrap           # install build deps (may need sudo)
npx fireforge import              # apply your patches (if any exist)
npx fireforge build               # build the browser
npx fireforge run                 # launch it
```

That's it. Your project now has `fireforge.json`, an `engine/` directory with Firefox source, and a `patches/` directory ready for your first customization.

---

## Core Workflow in 60 Seconds

```bash
# 1. Make changes inside engine/
#    Edit browser/base/content/browser.js, add CSS, create new modules...

# 2. Export your changes as a patch
npx fireforge export browser/base/content/browser.js \
  --name "custom-toolbar" --category ui

# 3. Your patch is now in patches/001-ui-custom-toolbar.patch
#    with metadata tracked in patches/patches.json

# 4. Later, reset and replay to verify everything applies cleanly
npx fireforge reset --force
npx fireforge import

# 5. When Firefox releases a new ESR, update fireforge.json, re-download, and rebase
npx fireforge download --force
npx fireforge rebase
```

---

## What You Get

- **Patch-based fork management** -- Your customizations live as portable, ordered `.patch` files. Export single files, multiple paths, or everything at once. Contextual diffs mean upstream security fixes aren't silently dropped.

- **Semi-automated ESR rebase** -- `fireforge rebase` replays your patch stack onto new Firefox source with escalating fuzz matching. When a patch fails, you fix it manually and `--continue`. The full stack gets re-exported with updated version stamps.

- **Wiring and registration** -- `fireforge wire` and `fireforge register` inject your code into Mozilla's startup paths, build manifests, and JAR files with a single command. AST-based injection survives formatting changes across versions.

- **Furnace component system** -- Override existing Firefox custom elements (CSS-only or full fork) or create new ones. Storybook preview included.

- **Design token management** -- Track CSS custom property coverage across your modified files.

- **Quality checks** -- `fireforge lint` catches fork-specific issues (raw colors, missing license headers, relative imports, large patches) before you export. `fireforge doctor` diagnoses project health.

- **Battle-tested** -- We run real end-to-end test passes against actual Firefox ESR 140 source code as part of development. The in-repo test suite is derived from those real-world runs, reflecting actual developer scenarios (multi-file patches, conflict resolution, manifest recovery, binary assets) without requiring 30 GB of Firefox source to execute. 1400+ tests run in under 15 seconds.

---

## Requirements

- **Node.js 20+**
- **Python 3** (required by Firefox's `mach` build system)
- **Git**
- Platform build tools (Xcode on macOS, `build-essential` on Linux, Visual Studio on Windows)

---

## Patch Workflow

Patches live in `patches/`, applied by numeric filename prefix, and tracked in `patches/patches.json`:

```
patches/
  001-branding-custom-logo.patch
  002-privacy-disable-telemetry.patch
  003-ui-sidebar-tweaks.patch
  patches.json
```

**Categories:** `branding` | `ui` | `privacy` | `security` | `infra`

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
```

### Rebasing onto a new Firefox version

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
      "sourceEsrVersion": "140.0esr",
      "filesAffected": ["browser/branding/official/logo.png"]
    }
  ]
}
```

If the manifest drifts after an interrupted export or manual edits, `fireforge import` will stop. Use `fireforge doctor --repair-patches-manifest` to rebuild it from disk.

</details>

<details>
<summary>Patch lint checks</summary>

`fireforge lint` runs automatically during export. Use `--skip-lint` to downgrade errors to warnings.

| Check                          | Scope                           | Severity |
| ------------------------------ | ------------------------------- | -------- |
| `missing-license-header`       | New files (JS/CSS/FTL)          | error    |
| `relative-import`              | JS/MJS files                    | error    |
| `token-prefix-violation`       | CSS files (with furnace)        | error    |
| `raw-color-value`              | CSS files                       | warning  |
| `missing-modification-comment` | Modified upstream JS/MJS        | warning  |
| `file-too-large`               | New files >650 lines            | warning  |
| `missing-jsdoc`                | Exports in new `.sys.mjs`       | warning  |
| `observer-topic-naming`        | Observer topics with binaryName | warning  |
| `large-patch-files`            | Patches affecting >5 files      | warning  |
| `large-patch-lines`            | Patches >300 lines              | warning  |

These catch fork-specific issues that Mozilla's `./mach lint` doesn't cover.

</details>

---

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
- **`--destroy <expr>`**: Adds destroy expression to `onUnload()` (LIFO ordering)
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

---

## Furnace (Component System)

```bash
fireforge furnace scan                              # discover available components
fireforge furnace override moz-button -t css-only   # fork an existing one
fireforge furnace create moz-my-widget              # create a new one
fireforge furnace deploy --dry-run                   # preview
fireforge furnace deploy                             # apply + validate
```

Furnace manages Firefox custom elements (`MozLitElement`). Override stock components with CSS-only restyles or full forks, or scaffold entirely new ones. Changes are applied to `engine/` and then captured by the patch system.

<details>
<summary>Component types</summary>

| Type         | Description                                                        | Local files                    |
| ------------ | ------------------------------------------------------------------ | ------------------------------ |
| **Stock**    | Engine components tracked for Storybook preview                    | None                           |
| **Override** | Forked copies -- `css-only` (restyle) or `full` (behavior + style) | `components/overrides/<name>/` |
| **Custom**   | New elements that don't exist in Firefox                           | `components/custom/<name>/`    |

</details>

<details>
<summary>Validation checks</summary>

Furnace validates components on deploy. Errors block apply; warnings are advisory.

| Check                    | Severity | Description                                 |
| ------------------------ | -------- | ------------------------------------------- |
| `missing-mjs`            | error    | Custom component missing `.mjs` file        |
| `missing-css`            | warning  | No `.css` file                              |
| `filename-mismatch`      | error    | File name doesn't match tag name            |
| `missing-override-json`  | error    | Override missing `override.json`            |
| `no-aria-role`           | warning  | No ARIA role found                          |
| `no-keyboard-handler`    | warning  | Has `@click` but no keyboard handler        |
| `relative-import`        | error    | Imports must use `chrome://` URIs           |
| `raw-color-value`        | error    | Raw hex/rgb/hsl (use CSS custom properties) |
| `token-prefix-violation` | error    | CSS variable doesn't match `tokenPrefix`    |

</details>

<details>
<summary>furnace.json schema</summary>

```jsonc
{
  "version": 1,
  "componentPrefix": "moz-",
  "stock": ["moz-button", "moz-toggle"],
  "overrides": {
    "moz-button": {
      "type": "css-only",
      "description": "Custom button styles",
      "basePath": "toolkit/content/widgets/moz-button",
      "baseVersion": "134.0",
    },
  },
  "custom": {
    "moz-my-widget": {
      "description": "A new widget",
      "targetPath": "toolkit/content/widgets/moz-my-widget",
      "register": true,
      "localized": false,
      "composes": ["moz-button"],
    },
  },
}
```

</details>

---

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
    "version": "140.0esr",
    "product": "firefox-esr"
  },
  "build": { "jobs": 8 },
  "wire": { "subscriptDir": "browser/components/mybrowser" }
}
```

Use `fireforge config <key> [value]` to read or update values. Run `fireforge --help` and `fireforge <command> --help` for the full option reference.

---

## Testing Methodology

FireForge's test suite is designed around a key insight: **realistic tests don't have to be slow.**

### Real Firefox validation

We run full end-to-end test passes against **real Firefox ESR 140 source code** in a production fork setup. These validate the entire workflow: setup, download, bootstrap, build, export, import, discard, and recovery.

### Derived in-repo tests

The 1400+ in-repo tests are **not idealized mocks**. They are derived from those real Firefox runs -- every fixture, edge case, and scenario was first observed against actual Firefox source, then distilled into a deterministic test that runs in seconds. Examples:

- CSS design tokens with `light-dark(#hex)` from a real 348-line tokens file
- BrowserGlue lazy import with `// BRAND:` markers from a real 2-hunk modification
- Multi-file theme patches spanning CSS + manifest + build system from real patches
- Observer topic regex edge cases from a real `notifyObservers` call

This means the fast test suite covers the same behavioral surface as the full-tree runs, without requiring 30 GB of Firefox source.

<details>
<summary>Running the full-tree suite</summary>

The opt-in full-tree suite exercises a connected workflow against a prepared Firefox project:

```bash
FIREFORGE_FULL_PROJECT_ROOT=/path/to/project npm run test:firefox-full
```

Optional environment variables:

- `FIREFORGE_FULL_BUILD_MODE=ui|full` -- defaults to `ui`
- `FIREFORGE_FULL_TARGET_FILE=browser/base/content/browser.js` -- override the target file for export/import
- `FIREFORGE_FULL_KEEP_PATCH=1` -- keep the temporary patch instead of cleaning up
- `FIREFORGE_FULL_SKIP_SETUP=1` -- skip `setup --force` for an already-prepared project

Each run writes artifacts under `.fireforge/full-integration-artifacts/<timestamp>/` in the target project.

</details>

---

<details>
<summary>Programmatic API</summary>

> **Pre-1.0 stability notice.** FireForge is at v0.9.x. The programmatic API
> exported from the main package entry point is functional and tested, but
> may change between minor versions until 1.0. Pin your dependency to an
> exact version if you rely on it.

FireForge can be used as a library in addition to the CLI:

```typescript
import { loadConfig, validateConfig, applyAllComponents, loadFurnaceConfig } from 'fireforge';
```

### Exported functions

| Function                | Module           | Purpose                                    |
| ----------------------- | ---------------- | ------------------------------------------ |
| `loadConfig`            | config           | Load and parse `fireforge.json`            |
| `validateConfig`        | config           | Validate a config object                   |
| `applyAllComponents`    | furnace-apply    | Apply all Furnace components to the engine |
| `ensureFurnaceConfig`   | furnace-config   | Create `furnace.json` if missing           |
| `loadFurnaceConfig`     | furnace-config   | Load and parse `furnace.json`              |
| `loadFurnaceState`      | furnace-config   | Load Furnace runtime state                 |
| `saveFurnaceState`      | furnace-config   | Persist Furnace runtime state              |
| `validateFurnaceConfig` | furnace-config   | Validate a Furnace config                  |
| `validateAllComponents` | furnace-validate | Validate all registered components         |
| `validateComponent`     | furnace-validate | Validate a single component                |
| `addToken`              | token-manager    | Add a design token                         |
| `getTokensCssPath`      | token-manager    | Get the path to the tokens CSS file        |
| `validateTokenAdd`      | token-manager    | Validate a token before adding             |

### Exported types

All configuration and result types are exported (`FireForgeConfig`, `FurnaceConfig`, `BuildConfig`, `ApplyResult`, `PatchInfo`, etc.). See `src/types/index.ts` for the full list.

### Error classes

All error classes extend `FireForgeError`:

- `CancellationError` — user-initiated cancellation
- `CommandError` — CLI command failure
- `GeneralError` — catch-all for unexpected failures
- `InvalidArgumentError` — bad input
- `ResolutionError` — dependency resolution failure

Use `ExitCode` for programmatic exit code handling.

</details>

---

## Roadmap

- **Docker builds** — Reproducible builds using Docker containers
- **CI mode** — Automated setup for continuous integration pipelines
- **Update manifests** — Generate update server manifests for auto-updates
- **Nightly** — Nightly support (requires `hg clone` from mozilla-central)

---

## License

[EUPL-1.2](LICENSE.md). Firefox source in `engine/` is under [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) and is not distributed by this repository.

During `fireforge setup`, you choose a license for your project files. Options: EUPL-1.2 (default), MPL-2.0, 0BSD, GPL-2.0-or-later. Firefox-derived files from Furnace always carry MPL-2.0 headers.
