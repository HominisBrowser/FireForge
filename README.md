# FireForge

**Build and maintain your own Firefox-based browser with a patch-first workflow.**

FireForge gives you a toolkit for forking Firefox: download a specific ESR release, manage your customisations as an ordered stack of contextual patches, survive version upgrades with semi-automated rebase, wire custom code into Mozilla's startup paths, and build the result. It also ships **Furnace**, a component system for creating and overriding Firefox custom elements.

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

Your project now has `fireforge.json`, an `engine/` directory with Firefox source, and a `patches/` directory ready for your first customisation.

A few things worth noting here: `bootstrap` may prompt for elevated permissions depending on your platform and what build dependencies are already present. This is not something we can avoid, since Mozilla's own `mach bootstrap` requires it, and wrapping that in our own sudo logic would be worse in every way that matters.

---

## Core Workflow

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

The reason your customisations live as patches rather than as a permanent fork branch is, in fairness, a trade-off. Branches are more familiar, but they make upstream merges progressively harder as your changes grow, and they obscure which modifications are intentional versus which are artefacts of merge resolution. Patches are explicit. Each one is a discrete, portable unit of intent. The cost is that you need tooling to manage the stack, which is what FireForge exists to provide.

---

## What You Get

- **Patch-based fork management.** Your customisations live as portable, ordered `.patch` files. Export single files, multiple paths, or everything at once. Contextual diffs mean upstream security fixes are not silently dropped when you rebase. This matters more then it might seem at first, because silent patch drift in a browser fork is the sort of bug that only surfaces when someone audits your security posture six months later.

- **Semi-automated ESR rebase.** `fireforge rebase` replays your patch stack onto new Firefox source with escalating fuzz matching. When a patch fails, you fix it manually and `--continue`. The full stack gets re-exported with updated version stamps. It would be cleaner to make this fully automatic, of course, but patches that touch the same code as upstream changes genuinely require human judgement about which intent should win. Pretending otherwise would be worse.

- **Wiring and registration.** `fireforge wire` and `fireforge register` inject your code into Mozilla's startup paths, build manifests, and JAR files with a single command. The injection is AST-based (via Acorn), not regex-based, which means it survives the formatting changes that Mozilla applies between versions. This is less about elegance then about not breaking on every minor release.

- **Furnace component system.** Override existing Firefox custom elements (CSS-only or full fork) or create new ones. Storybook preview included. The component types are `stock` (tracked for preview, no local files), `override` (CSS-only restyle or full behavioural fork), and `custom` (entirely new elements).

- **Design token management.** Track CSS custom property coverage across your modified files. This exists because raw colour values in a browser fork become a maintenance problem faster then you would expect, and catching them at export time is considerably cheaper then catching them during a visual regression review.

- **Quality checks.** `fireforge lint` catches fork-specific issues (raw colours, missing licence headers, relative imports, large patches) before you export. `fireforge doctor` diagnoses project health. These are not redundant with Mozilla's own `./mach lint`, which does not know about your fork-specific conventions.

- **Tested against real Firefox source.** We run end-to-end test passes against actual Firefox ESR 140 source code as part of development. The in-repo test suite is derived from those real-world runs, reflecting actual developer scenarios (multi-file patches, conflict resolution, manifest recovery, binary assets) without requiring 30 GB of Firefox source to execute. 1400+ tests run in under 15 seconds.

---

## Requirements

- **Node.js 20+.** Version 18 will appear to work initially, but the native fetch usage in the request layer will fail silently in certain edge cases, which is the sort of thing you would rather discover now.
- **Python 3** (required by Firefox's `mach` build system).
- **Git.**
- Platform build tools: Xcode on macOS, `build-essential` on Linux, Visual Studio on Windows. If you are on an M-series Mac and encounter native module compilation errors, this is almost certainly the `sharp` dependency in your broader toolchain, not FireForge itself.

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

The category system is intentionally coarse. Finer-grained categorisation sounds appealing in theory, but in practice it creates more classification arguments then it resolves, and the numeric ordering already handles sequencing.

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

Mind you, the rebase process is deliberately conservative: it will stop at the first patch that cannot be applied cleanly rather then guessing at a resolution and potentially corrupting your intent. This is slower but considerably safer, especially for security-sensitive patches where a misapplied hunk could silently undo a fix.

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

If the manifest drifts after an interrupted export or manual edits, `fireforge import` will stop rather then silently applying a stale stack. Use `fireforge doctor --repair-patches-manifest` to rebuild it from disk. The rebuild is deterministic: it reads patch headers, not cached state, so the result is always consistent with what is actually on the filesystem.

</details>

<details>
<summary>Patch lint checks</summary>

`fireforge lint` runs automatically during export. Use `--skip-lint` to downgrade errors to warnings, though I would recommend against making that a habit.

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

These catch fork-specific issues that Mozilla's `./mach lint` does not cover. The severity levels are not arbitrary: errors block export because they indicate structural problems that will cause failures downstream, while warnings flag things that are suboptimal but not immediately dangerous.

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

---

## Furnace (Component System)

```bash
fireforge furnace scan                              # discover available components
fireforge furnace override moz-button -t css-only   # fork an existing one
fireforge furnace create moz-my-widget              # create a new one
fireforge furnace deploy --dry-run                   # preview
fireforge furnace deploy                             # apply + validate
```

Furnace manages Firefox custom elements (`MozLitElement`). Override stock components with CSS-only restyles or full forks, or scaffold entirely new ones. Changes are applied to `engine/` and then captured by the patch system, which means Furnace is not a separate persistence layer; it feeds into the same patch workflow as everything else.

<details>
<summary>Component types</summary>

| Type         | Description                                                       | Local files                    |
| ------------ | ----------------------------------------------------------------- | ------------------------------ |
| **Stock**    | Engine components tracked for Storybook preview                   | None                           |
| **Override** | Forked copies: `css-only` (restyle) or `full` (behaviour + style) | `components/overrides/<name>/` |
| **Custom**   | New elements that do not exist in Firefox                         | `components/custom/<name>/`    |

</details>

<details>
<summary>Validation checks</summary>

Furnace validates components on deploy. Errors block apply; warnings are advisory. The distinction is not about severity in the abstract but about whether a violation will cause a runtime failure versus a maintenance headache.

| Check                    | Severity | Description                                 |
| ------------------------ | -------- | ------------------------------------------- |
| `missing-mjs`            | error    | Custom component missing `.mjs` file        |
| `missing-css`            | warning  | No `.css` file                              |
| `filename-mismatch`      | error    | File name does not match tag name           |
| `missing-override-json`  | error    | Override missing `override.json`            |
| `no-aria-role`           | warning  | No ARIA role found                          |
| `no-keyboard-handler`    | warning  | Has `@click` but no keyboard handler        |
| `relative-import`        | error    | Imports must use `chrome://` URIs           |
| `raw-color-value`        | error    | Raw hex/rgb/hsl (use CSS custom properties) |
| `token-prefix-violation` | error    | CSS variable does not match `tokenPrefix`   |

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

Use `fireforge config <key> [value]` to read or update values. Run `fireforge --help` and `fireforge <command> --help` for the full option reference. The `jobs` value defaults to your CPU core count, which is usually reasonable but not always optimal; Firefox's build system has enough sequential bottlenecks that doubling your core count does not halve your build time, for what it is worth.

---

## Testing Methodology

FireForge's test suite is designed around a constraint that, at least in my experience, does not get enough attention: realistic tests do not have to be slow.

### Real Firefox validation

We run full end-to-end test passes against real Firefox ESR 140 source code in a production fork setup. These validate the entire workflow: setup, download, bootstrap, build, export, import, discard, and recovery.

### Derived in-repo tests

The 1400+ in-repo tests are not idealised mocks. They are derived from those real Firefox runs. Every fixture, edge case, and scenario was first observed against actual Firefox source, then distilled into a deterministic test that runs in seconds. Examples:

- CSS design tokens with `light-dark(#hex)` from a real 348-line tokens file
- BrowserGlue lazy import with `// BRAND:` markers from a real 2-hunk modification
- Multi-file theme patches spanning CSS + manifest + build system from real patches
- Observer topic regex edge cases from a real `notifyObservers` call

This means the fast test suite covers the same behavioural surface as the full-tree runs, without requiring 30 GB of Firefox source. It would be fair to call the fixtures "synthetic" in the sense that they are not the original files, but the scenarios they encode are not invented; they are reproductions of real behaviour we observed during development.

<details>
<summary>Running the full-tree suite</summary>

The opt-in full-tree suite exercises a connected workflow against a prepared Firefox project:

```bash
FIREFORGE_FULL_PROJECT_ROOT=/path/to/project npm run test:firefox-full
```

Optional environment variables:

- `FIREFORGE_FULL_BUILD_MODE=ui|full` (defaults to `ui`)
- `FIREFORGE_FULL_TARGET_FILE=browser/base/content/browser.js` (override the target file for export/import)
- `FIREFORGE_FULL_KEEP_PATCH=1` (keep the temporary patch instead of cleaning up)
- `FIREFORGE_FULL_SKIP_SETUP=1` (skip `setup --force` for an already-prepared project)

Each run writes artefacts under `.fireforge/full-integration-artifacts/<timestamp>/` in the target project.

</details>

---

<details>
<summary>Programmatic API</summary>

> **Pre-1.0 stability notice.** FireForge is at v0.9.x. The programmatic API
> exported from the main package entry point is functional and tested, but
> may change between minor versions until 1.0. Pin your dependency to an
> exact version if you rely on it. I would rather be honest about this then
> pretend the API surface is frozen when it is not.

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

- `CancellationError` (user-initiated cancellation)
- `CommandError` (CLI command failure)
- `GeneralError` (catch-all for unexpected failures)
- `InvalidArgumentError` (bad input)
- `ResolutionError` (dependency resolution failure)

Use `ExitCode` for programmatic exit code handling.

</details>

---

## Roadmap

These are planned but not yet implemented. I mention them here for transparency rather then as a promise, since priorities shift and some of these may prove harder then they look.

- **Docker builds.** Reproducible builds using Docker containers. The main challenge is keeping the image size reasonable given Firefox's build dependency tree.
- **CI mode.** Automated setup for continuous integration pipelines.
- **Update manifests.** Generate update server manifests for auto-updates.
- **Nightly support.** This requires `hg clone` from mozilla-central rather then the archive download path, which is a meaningfully different code path.

---

## Licence

[EUPL-1.2](LICENSE.md). Firefox source in `engine/` is under [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) and is not distributed by this repository.

During `fireforge setup`, you choose a licence for your project files. Options: EUPL-1.2 (default), MPL-2.0, 0BSD, GPL-2.0-or-later. Firefox-derived files from Furnace always carry MPL-2.0 headers, because that is what the upstream licence requires regardless of your project-level choice.
