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

| Check                          | Scope                                                                     | Severity                 |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------ |
| `missing-license-header`       | New files (JS/CSS/FTL)                                                    | error                    |
| `relative-import`              | JS/MJS files                                                              | error                    |
| `token-prefix-violation`       | CSS files (with furnace)                                                  | error                    |
| `raw-color-value`              | Introduced CSS color values (allowlist via `patchLint.rawColorAllowlist`) | error                    |
| `duplicate-new-file-creation`  | Same path created by multiple patches                                     | error                    |
| `forward-import`               | Patch imports from a later-patch file                                     | error                    |
| `missing-jsdoc`                | Exports in patch-owned `.sys.mjs`                                         | error                    |
| `jsdoc-param-mismatch`         | Exports in patch-owned `.sys.mjs`                                         | error                    |
| `jsdoc-missing-returns`        | Exports in patch-owned `.sys.mjs`                                         | error                    |
| `checkjs-type-error`           | Patch-owned `.sys.mjs` (opt-in)                                           | error                    |
| `missing-modification-comment` | Modified upstream JS/MJS                                                  | warning                  |
| `modified-file-missing-header` | Modified upstream files (JS/CSS/FTL)                                      | warning                  |
| `file-too-large`               | New files (tiered: 500/750/900 general, 1200/1400/1600 test)              | notice / warning / error |
| `observer-topic-naming`        | Observer topics with binaryName                                           | warning                  |
| `large-patch-files`            | Patches affecting >5 files                                                | warning                  |
| `large-patch-lines`            | Patch line count (tiered: 800/1500/3000 general, 1500/3000/6000 test)     | notice / warning / error |

**JSDoc validation** uses AST-based analysis (Acorn) to validate exported APIs in patch-owned `.sys.mjs` files. A file is "patch-owned" if it was newly created by the current diff or by an existing patch in the queue. Functions must document every `@param` (names must match) and include `@returns` when the function returns a value. Exported constants and classes require a JSDoc block.

**Optional `checkJs` pass.** Enable a TypeScript-esque bastardization of type checking for patch-owned `.sys.mjs` files by adding `"patchLint": { "checkJs": true }` to `fireforge.json`. This uses the TypeScript compiler API with `allowJs + checkJs + noEmit`, scoped only to patch-owned files. Firefox globals (`Services`, `ChromeUtils`, `lazy`, etc.) are shimmed automatically. Module-resolution errors from Firefox's `resource://` and `chrome://` URL schemes are suppressed since TypeScript cannot follow these. This pass solely focuses on type errors within the patch-owned code itself (mismatched JSDoc types, wrong argument counts, unreachable code, etc.).

The two cross-patch rules (`duplicate-new-file-creation` and `forward-import`) run over the whole patch queue rather than a single diff, catching ordering issues that only surface during `import`. Forward-import detection compares leaf filenames, so a false positive is theoretically possible when two patches create files with the same basename in different directories. Suppress with an inline `// fireforge-ignore: forward-import` comment on or above the import line. Both `forward-import` and `raw-color-value` support inline suppression comments (`// fireforge-ignore: forward-import` and `/* fireforge-ignore: raw-color-value */` respectively).

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
| Ordinal gaps after deletes/splits              | `fireforge patch compact`                                             |
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

| File pattern                                | Manifest                              | Entry format                        |
| ------------------------------------------- | ------------------------------------- | ----------------------------------- |
| `browser/themes/shared/*.css`               | `browser/themes/shared/jar.inc.mn`    | `skin/classic/browser/{name}.css`   |
| `browser/base/content/*.{js,mjs,xhtml,css}` | `browser/base/jar.mn`                 | `content/browser/{file}`            |
| `browser/base/content/test/*/browser.toml`  | `browser/base/moz.build`              | `"content/test/{dir}/browser.toml"` |
| `browser/modules/mybrowser/*.sys.mjs`       | `browser/modules/mybrowser/moz.build` | `"{name}.sys.mjs"`                  |
| `toolkit/content/widgets/*/*.{mjs,css}`     | `toolkit/content/jar.mn`              | `content/global/elements/{file}`    |

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
fireforge furnace chrome-doc create mybrowser      # scaffold a top-level chrome document
fireforge furnace deploy                           # apply to engine/ + validate
fireforge furnace status                           # workspace vs engine drift
fireforge furnace diff moz-button                  # unified diff against baseline
```

`furnace deploy` validates components before applying. As always, errors block, warnings are advisory. `fireforge build` and `fireforge test --build` run apply automatically — when apply wrote files during a build, the build prints a `Furnace: source → engine sync wrote N component(s) …` banner naming every component that was synced, so it is obvious whether engine/ was freshly updated. Use `fireforge doctor --repair-furnace` if the engine gets out of sync.

### Scaffolding top-level chrome documents

Custom elements live under `toolkit/content/widgets`, but a fork's top-level chrome document (`browser.xhtml` equivalents like `mybrowser.xhtml`, `about:*` panels, onboarding flows) lives at `browser/base/content/` and needs jar.mn, jar.inc.mn, and locales/jar.mn entries to reach the packaged bundle. `furnace chrome-doc create <name>` handles that boilerplate:

```bash
fireforge furnace chrome-doc create mybrowser              # full chrome (titlebar + windowtype)
fireforge furnace chrome-doc create overlay --no-titlebar  # frameless overlay
```

The command writes:

- `engine/browser/base/content/<name>.xhtml` — XHTML shell, optional titlebar-buttonbox, Fluent `<link>`.
- `engine/browser/base/content/<name>.js` — startup-topic observer fired on first idle.
- `engine/browser/themes/shared/<name>-chrome.css` — scoped CSS; emits the macOS `.titlebar-button { display: none }` carve-out under `--no-titlebar`.
- `engine/browser/locales/en-US/browser/<name>.ftl` — Fluent stub keyed on `<name>-window-title`.
- Appends the corresponding `jar.mn` / `jar.inc.mn` / `locales/jar.mn` entries.

Writes are transactional: a SIGINT mid-scaffold rolls back every touched file. Requires an existing engine — run `fireforge download` first.

### Picking a test harness for `furnace create`

`furnace create --with-tests` defaults to a MochiKit test at `engine/toolkit/content/tests/widgets/test_<tag>.html`. MochiKit tests load the component module via `chrome://global/` and don't need a `tabbrowser`, so they run against any fork — including bespoke chrome documents (`mybrowser.xhtml`-class) that deliberately omit the upstream browser chrome.

Three styles are available via `--test-style`:

| Style            | When to use                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mochikit`       | Default. Pure-UI custom elements. Runs today against non-tabbrowser chrome. Emits `test_<tag>.html` under `toolkit/content/tests/widgets/`.                                                                         |
| `browser-chrome` | Element talks to the browser window (open URLs, manipulate tabs). Requires a working `tabbrowser` in the chrome document. Emits the `browser_<bin>_<tag>.js` scaffold and registers it in `browser/base/moz.build`. |
| `xpcshell`       | Storage-layer, observer-driven, or ESM-loading code. Headless, no tabbrowser. Emits `test_<name>_module_loads.js` + `xpcshell.toml` (registration in `XPCSHELL_TESTS_MANIFESTS` is left to the operator).           |

`--xpcshell` is preserved as an alias for `--test-style=xpcshell`; conflicting flag combinations (`--xpcshell --test-style=mochikit`) are rejected.

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

# Close ordinal gaps after deletes or splits (e.g. 1, 3, 7 → 1, 2, 3)
fireforge patch compact
```

All subcommands support `--dry-run` and `--yes`.

### Additional workflow commands

```bash
# Package the built browser for distribution
fireforge package

# Watch for file changes and auto-rebuild
fireforge watch

# Add a CSS design token
fireforge token --name "--my-color" --value "light-dark(#fff, #000)"
```

### Diff-scoped lint (`lint --since`)

`fireforge lint --since <git-rev>` tags each issue as `[introduced]` or `[cumulative]` based on whether its file changed since `<git-rev>`:

```bash
fireforge lint --since HEAD~1            # just the current commit
fireforge lint --since main              # everything since main
fireforge lint --since abc1234           # since a specific SHA
```

The summary line splits counts — e.g. `Lint: 2 introduced error(s), 0 introduced warning(s); 5 cumulative error(s), 1 cumulative warning(s)` — so triage of "did my diff introduce any of these?" is a one-glance check on a large patch series. Exit code still fails on any error (introduced or cumulative); the flag is purely a display / audit tool. Without `--since`, output is unchanged.

### Post-build audit and auto-configure

`fireforge build` is a transactional step: after a successful mach build it audits the dist bundle against engine-relative paths touched since the last successful build, and warns per file that is packageable-by-convention (`.js`/`.mjs`/`.css`/`.ftl`/`.xhtml`/`app/profile/…`) but has no matching artifact or whose dist mtime is older than the source. Ends every build with a `Packaged: N updated, M stale, K missing, S skipped` summary. The audit is warn-only — it never fails a build that mach reported green.

The audit applies six routing rules to suppress false positives that previously trained operators to ignore its warnings:

- **Build inputs are excluded.** `jar.mn`, `moz.build`, `moz.configure`, `Makefile.in`, and `mozbuild.in` are consumed by the build to produce chrome registrations / make targets but never themselves ship. They are skipped before the dist lookup, so editing them no longer fires a "missing packaged artifact" warning.
- **Same-basename collisions in `dist/` are disambiguated by trailing-segment overlap.** A branding override at `engine/browser/branding/<name>/content/aboutDialog.css` ships at `chrome/<area>/content/branding/aboutDialog.css`. A naive basename match would tie that against the unrelated upstream `chrome/<area>/content/browser/aboutDialog.css`; the audit now scores candidates by trailing path-segment match plus a small bonus for non-generic source segments (`branding`, the branding directory name) appearing in the candidate path, so re-rooted artifacts win over coincidentally-named ones.
- **Unrelated same-basename hits never surface as "stale".** When the best-scoring candidate shares only the basename with the source and no meaningful intermediate segment (common on sparsely-populated `_tests/` trees where an upstream helper like `head.js` is the only same-basename file left from a prior build), the audit classifies the file as `missing` rather than emitting a misleading stale-comparison warning against the unrelated candidate. The warning names the unrelated file so the operator can confirm the mismatch at a glance.
- **Test sources are looked up under `_tests/`, not `dist/`.** Anything under `/test(s)/` directories, plus `browser_*.js` / `test_*.js` / `xpcshell.toml` / `browser.ini`, is resolved against the `_tests/` tree under the active `obj-*` directory. Mochitest and xpcshell harnesses copy registered tests there, never into the packaged bundle. Misses still warn — but they point at `_tests/`, directing the operator to `BROWSER_CHROME_MANIFESTS` / `XPCSHELL_TESTS_MANIFESTS` instead of `package-manifest.in`.
- **Test-path audits are gated on `_tests/all-tests.json`.** Plain `mach build` populates a partial `_tests/` subtree and stops — full test packaging only runs under `mach package-tests` / `mach test <target>` (or `fireforge test <name>`). The audit now checks for the `all-tests.json` marker written by the packaged-tests make target and silently skips test-path sources when the marker is absent, so every registered mochitest / xpcshell source no longer false-flags as "missing" on the common build-only path. Run `cd engine && ./mach package-tests` (or a scoped `fireforge test`) after a build to green-check test registrations.
- **Files inside an `if CONFIG[…]:` block in their owning `moz.build` are skipped on hosts where the gate is off.** Windows-only stubinstaller CSS on a macOS build, Darwin-only artwork on Linux, etc. The detection walks up to the closest `moz.build`, scans for the basename inside a Python-style indented `if CONFIG[…]:` block, and matches the gate against the host platform. Negation expressions are conservatively NOT treated as single-OS gates so a warning is never wrongly suppressed for a file that should ship on the current host. Subtrees packaged through platform-specific `Makefile.in` recipes that live outside the `moz.build` graph — `/stubinstaller/` (NSIS), `browser/installer/windows/`, `browser/installer/macosx/`, `browser/installer/linux/` — are also gated by path convention so branding stubinstaller CSS no longer warns on every non-Windows build.

The build also auto-runs `mach configure` before the mach build step when any `moz.build`, `moz.configure`, or `Makefile.in` changed since the last successful build. Prevents incremental builds from silently skipping work against a stale recursive-make backend. Emits a `Backend config changed; running mach configure first...` banner when it fires.

Mach build failures with known-cryptic mozbuild errors now print actionable hints. Example: a `JS_PREFERENCE_PP_FILES` entry with no `#filter` / `#expand` directives now prints `Hint: ...use JS_PREFERENCE_FILES instead, or add at least one #filter / #expand directive to the file.` alongside the raw mach traceback.

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
  "wire": { "subscriptDir": "browser/components/mybrowser" },
  "patchLint": {
    "checkJs": true,
    "rawColorAllowlist": ["mybrowser-tokens.css"]
  },
  "markerComment": "MYBROWSER"
}
```

**`markerComment`** (optional). Appended as a `  // <marker>:` suffix to every line FireForge writes into upstream Firefox source files (starting with `customElements.js`). Keeps fork modifications discoverable and makes re-apply idempotent without hand-tagging entries after each `furnace apply`. Reject list: empty strings, leading/trailing whitespace, newlines, `*/` (would close an enclosing block comment), control characters.

**`furnace.json.tokenHostDocuments`** (optional). List of chrome XHTML documents the `missing-token-link` validator scans for the tokens CSS link. Forks with a second chrome host (e.g. `mybrowser.xhtml` alongside `browser.xhtml`) should list every document that may own the link — the rule fires only when NONE of them link the tokens CSS. Defaults to `["browser/base/content/browser.xhtml"]` when omitted. `fireforge doctor`'s engine-paths probe reads the same field when confirming the chrome document exists on disk, and `fireforge wire --dom` uses the first entry as the default target for its `#include` directive (override per-invocation with `--target <path>`). Forks that fully replaced `browser.xhtml` with a custom top-level chrome document configure this field once and both checks agree.

### `furnace create --localized` for `MozLitElement`

`fireforge furnace create <tag> --localized` scaffolds a Fluent-ready component. The generated `.mjs` uses the Mozilla-idiomatic `MozLitElement` pattern: a module-level `window.MozXULElement?.insertFTLIfNeeded("<chrome-uri>")` plus `this.ownerDocument.l10n?.connectRoot(this.shadowRoot)` / `disconnectRoot` in `connectedCallback` / `disconnectedCallback`. The chrome URI derives from `furnace.json.ftlBasePath` (default `toolkit/locales/en-US/toolkit/global` → `toolkit/global/<tag>.ftl`). `furnace apply` registers the `.ftl` in the matching locale jar.mn (default `toolkit/locales/jar.mn`) so the chrome URI resolves at runtime. If the locale jar.mn is missing in your fork (non-standard tree), apply surfaces a structured step error instead of aborting — the `.mjs`/`.css` still ship.

### `fireforge test --doctor`

```bash
# Sub-minute marionette handshake probe; bails out of mach test on FAIL
fireforge test --doctor
fireforge test --doctor browser/base/content/test/foo/browser_bar.js
```

Spawns the built browser headless, waits for a marionette handshake on `127.0.0.1:2828`, and reports PASS/FAIL with the tail of the browser's stderr on FAIL. Distinguishes "marionette wedged" (socket silent) from "mach test discovery failed" — both otherwise surface as a silent 360-second hang followed by `Passed: 0, Failed: 0`. Useful as a prefix on routine `fireforge test` invocations when marionette has been flaky.

The probe is a cascade of six layered checks — engine-present → mach-available → python-available → profile-creatable → browser-spawns → marionette-handshake. Each failure is tagged `[layer N/6: <name>]` so the first broken layer is surfaced immediately instead of the whole cascade blocking on the final socket poll. When the browser binary crashes at startup (missing dylib, wrong CPU arch, corrupt profile) the cascade fails at layer 5 within the settle window, not after the full socket timeout.

### Runtime CSS variables in Furnace

Design tokens imported from the fork's palette are enforced by `tokenPrefix`, but some components write and read CSS custom properties as runtime state channels (`--cam-x` per frame, `--tile-z` from a hit-test observer). Two escape hatches exist:

- **Auto-exempt** — a variable that is both declared (`--foo: 0;`) and consumed (`var(--foo)`) inside the same component's CSS file is recognised as a component-local runtime channel. No config entry required.
- **`furnace.json.runtimeVariables`** — explicit allowlist for names that are _written_ in JS and _read_ in a different file's CSS (cross-component runtime channels that the CSS-only auto-exempt cannot see). Entries must start with `--`.

Both rules compose with the existing `tokenPrefix` / `tokenAllowlist` checks and apply to both component validation and patch-stack lint.

### Test harness options

`fireforge furnace create --with-tests` scaffolds a **browser-chrome mochitest**. Use this when the component renders UI that depends on the tab strip (`openLinkIn` → `URILoadingHelper`, `gBrowser`, etc.).

`fireforge furnace create --xpcshell` scaffolds an **xpcshell test harness** instead. Use this when the component's code path is storage-only, observer-driven, or module-loading logic that does not touch a `tabbrowser`. xpcshell runs headless without browser chrome, so forks without an upstream tab strip can still cover these paths. The scaffolder writes `test_<name>_module_loads.js` + `xpcshell.toml` into `engine/browser/base/content/test/<binary-name>-xpcshell/<component-name>/` and prints a note: registration in `XPCSHELL_TESTS_MANIFESTS` is the operator's call (the moz.build that should own the entry depends on where the component actually lives).

The two flags can be combined — `--with-tests --xpcshell` writes both harnesses.

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
