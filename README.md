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
- **Watchman** (optional, only required by `fireforge watch`). Install via `brew install watchman` (macOS), `dnf install watchman` (Fedora), or follow the upstream [Meta docs](https://facebook.github.io/watchman/). `fireforge doctor` surfaces a warning row when it is not on `PATH` so the dependency is visible during the usual onboarding sweep rather than at the watch-mode failure site.

### Setup

```bash
mkdir mybrowser && cd mybrowser
npm init -y
npm install --save-dev @hominis/fireforge

npx fireforge setup               # interactive project init
npx fireforge download            # fetch Firefox source (~1 GB)
npx fireforge bootstrap           # install build deps (may need sudo)
npx fireforge import              # apply your patches (if any exist)
npx fireforge build               # build the browser
npx fireforge run                 # launch it
```

Your project now has `fireforge.json`, an `engine/` directory with Firefox source and a `patches/` directory with an empty `patches.json` manifest ready for your first customisation.

#### Known upstream build issues

- **macOS 15 (Darwin 25+) — `gecko-profiler` bindgen error `cannot find type _CharT in this scope`.** An Apple toolchain update changed `std::__CharT_pointer` to `_CharT_pointer` in the libc++ headers Firefox's bindgen walks, so `toolkit/library/rust/target-objects` fails during `mach build` even on a clean `fireforge bootstrap`. This is an upstream Firefox issue, not a FireForge bug. Two workarounds: pin Xcode's command line tools to a pre-September-2025 release via `xcode-select --install` / [Apple developer downloads](https://developer.apple.com/download/all/), or apply a one-line bindgen-basic-string-workaround patch (Hominis ships one in its patch queue). If you interrupt the resulting `fireforge build` and re-run `fireforge doctor`, the download/engine state is unaffected — the failure is isolated to the Rust compile phase.

### Workflow Overview

1. Make changes inside the `engine/` directory.
2. Export your changes as a patch:

```bash
npx fireforge export browser/base/content/browser.js --name "custom-toolbar" --category ui
```

3. Your patch is now in `patches/`.
4. Reset and import to verify everything applies cleanly:

```bash
npx fireforge reset --yes
npx fireforge import              # --dry-run to preview without applying
```

5. When Mozilla releases a new version, update fireforge.json, re-download and rebase:

```bash
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

`export`, `export-all`, `lint`, `register`, and `test` all accept either engine-relative paths (`browser/base/content/foo.js`) or repo-root-relative paths with a leading `engine/` segment (`engine/browser/base/content/foo.js`). The prefix is case-insensitive and tolerates leading whitespace; operators commonly paste the repo-rooted form from `git status` output or shell tab-completion.

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

# Refresh every patch AND stamp sourceEsrVersion from fireforge.json onto each
# one. Only stamps when every selected patch refreshes cleanly — partial
# runs refuse to stamp. Use when you re-exported after a manual Firefox
# bump that did not go through `rebase`. By default `re-export` refreshes
# patch bodies and filesAffected but does NOT change sourceEsrVersion.
fireforge re-export --all --scan --stamp
```

`export` refuses when the new patch's `filesAffected` would overlap with files already claimed by another non-superseded patch. Repartitioning ownership is a deliberate operation: the message points at `fireforge re-export --files <paths> <patch>` as the safe primitive. Pass `--allow-overlap` to acknowledge the conflict and proceed anyway — the resulting queue will fail `fireforge verify` immediately, so this is an intentional escape hatch, not a default.

`re-export --scan` also prompts before broadening a patch with more than a handful of newly discovered files or with files spanning multiple directories. The gate keeps the common refresh case frictionless (small, same-directory additions) while catching the failure mode where `--scan` silently pulls an adjacent feature into the wrong patch. Non-interactive mode requires `--yes` to acknowledge a broad expansion; dry-run previews never require confirmation.

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
      "filesAffected": ["browser/branding/official/logo.png"],
      "lintIgnore": ["large-patch-lines", "large-patch-files"]
    }
  ]
}
```

The optional `lintIgnore` field lists lint check IDs to suppress for that patch specifically. Useful for the class of patch that is advisory-noisy by nature — a cohesive branding bundle, a localised-resource pack, an auto-generated manifest — where `--skip-lint` is too blunt and a per-line marker cannot exist (the `.patch` body is regenerated on every export). Threaded through `export`, `re-export`, `re-export --files`, and `lint --per-patch`. Unknown check IDs are a no-op.

If the manifest drifts after an interrupted export or manual edits, `fireforge import` will stop rather then silently applying a stale stack. Use `fireforge doctor --repair-patches-manifest` to rebuild it from disk. Because the rebuild is deterministic, the result will always be consistent with what is actually on the filesystem.

</details>

<details>
<summary>Patch lint checks</summary>

`fireforge lint` runs automatically during export, export-all and re-export. Use `--skip-lint` to downgrade errors to warnings. Errors block the export; warnings are printed but do not block.

By default, a standalone `fireforge lint` (no arguments) lints the **aggregate** `git diff HEAD` — i.e. every applied patch summed. On a repo where `fireforge import` or `fireforge rebase` has just applied the full queue, the patch-size rules (`large-patch-lines`, `large-patch-files`) fire against the sum, which reads as "my queue is broken" when it is really an artefact of aggregation. Use `fireforge lint --per-patch` to rescope the diff to each patch's own `filesAffected`, honouring the patch's own `lintIgnore`. Cross-patch rules (`duplicate-new-file-creation`, `forward-import`) still run once over the whole queue either way. Pass explicit file paths to narrow the scope further; the three modes (aggregate, file-scoped, per-patch) are mutually exclusive.

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

# Register a file in the correct build manifest (engine-relative or
# repo-root-relative — a leading `engine/` segment is stripped)
fireforge register browser/modules/mybrowser/MyStore.sys.mjs
fireforge register engine/browser/modules/mybrowser/MyStore.sys.mjs

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
fireforge furnace chrome-doc create mybrowser --with-tests # + xpcshell packaging-verification test
```

The command writes:

- `engine/browser/base/content/<name>.xhtml` — XHTML shell, optional titlebar-buttonbox, Fluent `<link>`.
- `engine/browser/base/content/<name>.js` — startup-topic observer fired on first idle.
- `engine/browser/themes/shared/<name>-chrome.css` — scoped CSS; emits the macOS `.titlebar-button { display: none }` carve-out under `--no-titlebar`.
- `engine/browser/locales/en-US/browser/<name>.ftl` — Fluent stub keyed on `<name>-window-title`.
- Appends the corresponding `jar.mn` / `jar.inc.mn` / `locales/jar.mn` entries.
- When `--with-tests` is set, also scaffolds an xpcshell test + `xpcshell.toml` under `engine/browser/base/content/test/<binary>-xpcshell/<name>/` that probes the packaged app directory (`Services.dirsvc.get("XCurProcD")/chrome/browser/...`) directly rather than going through `chrome://` URI resolution — see "Platform module compatibility" and the xpcshell chrome-URI note further down for why direct filesystem probing is the reliable way to verify chrome-doc packaging. Registration in `XPCSHELL_TESTS_MANIFESTS` is left to the operator because the owning moz.build depends on the fork layout.

Writes are transactional: a SIGINT mid-scaffold rolls back every touched file. Requires an existing engine — run `fireforge download` first.

#### Platform module compatibility

A custom chrome document with `windowtype="navigator:browser"` is treated as a main browser window by every upstream platform module that observes `browser-delayed-startup-finished` — `DevToolsStartup`, `PageActions`, `SessionStore`, `DownloadsButton`, Sync UI, and more. Those modules walk INTO the window assuming `browser.xhtml`'s DOM (`<menu>` entries, `window.BrowserPageActions`, the `cmd_*` command set, the tabbrowser, …) and throw a `TypeError` on anything else. The errors are non-fatal but noisy, and the matrix of "which modules walk in" grows with every Firefox release.

Every `furnace chrome-doc create`-scaffolded root element now carries a `data-furnace-chrome-doc="<name>"` sentinel attribute. Fork-side patches to the offending platform modules can guard on this attribute cheaply:

```js
// DevToolsStartup.sys.mjs (fork patch)
observe(subject, topic) {
  if (topic === "browser-delayed-startup-finished") {
    const win = subject.QueryInterface(Ci.nsIDOMWindow);
    if (win.document.documentElement.hasAttribute("data-furnace-chrome-doc")) {
      return;  // fork's custom chrome doc — skip DevTools menubar wiring
    }
    // ... upstream body ...
  }
}
```

The sentinel is fork-neutral (the attribute name is stable across projects) so a fork upgrading from one FireForge version to the next does not have to rewrite every guard. The name carried in the attribute value distinguishes multiple chrome docs in the same fork when a patch needs finer-grained routing.

#### Harness matrix gap

`furnace chrome-doc create` generates a top-level chrome document, but neither of the two existing test harnesses (`furnace create --test-style=mochikit`, `--test-style=browser-chrome`) covers it well: mochikit targets widgets loaded via `chrome://global/` (no tabbrowser, but also no chrome-doc-level interactive behaviors like titlebar drag / focus-ring / window sizing), and browser-chrome mochitest requires a working `tabbrowser` which a fork-authored chrome document that replaces `browser.xhtml` deliberately does not carry. Running a tabbrowser-less window through the mochikit harness crashes the harness itself (on `URILoadingHelper.openLinkIn`), not the chrome doc.

The packaging-verification test that `--with-tests` scaffolds is what FireForge can offer cleanly from inside the current harness matrix: it asserts the packaged files landed, not that they behave correctly at runtime. Interactive assertions (dot-grid background painting, titlebar drag region, focus ring) are out of scope for this scaffold and require manual verification against a built browser until the upstream harness matrix catches up.

### Picking a test harness for `furnace create`

`furnace create --with-tests` defaults to a MochiKit test at `engine/toolkit/content/tests/widgets/test_<tag>.html`. MochiKit tests load the component module via `chrome://global/` and don't need a `tabbrowser`, so they run against any fork — including bespoke chrome documents (`mybrowser.xhtml`-class) that deliberately omit the upstream browser chrome.

Three styles are available via `--test-style`:

| Style            | When to use                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mochikit`       | Default. Pure-UI custom elements. Runs today against non-tabbrowser chrome. Emits `test_<tag>.html` under `toolkit/content/tests/widgets/`.                                                                         |
| `browser-chrome` | Element talks to the browser window (open URLs, manipulate tabs). Requires a working `tabbrowser` in the chrome document. Emits the `browser_<bin>_<tag>.js` scaffold and registers it in `browser/base/moz.build`. |
| `xpcshell`       | Storage-layer, observer-driven, or ESM-loading code. Headless, no tabbrowser. Emits `test_<name>_module_loads.js` + `xpcshell.toml` (registration in `XPCSHELL_TESTS_MANIFESTS` is left to the operator).           |

`--xpcshell` is preserved as an alias for `--test-style=xpcshell`; conflicting flag combinations (`--xpcshell --test-style=mochikit`) are rejected.

`furnace create --dry-run` previews the planned file set, test scaffold, and `furnace.json` mutation without writing anything. Every validation the real command runs (tag-name shape, name conflicts, engine pre-existence of the component, `--compose` target existence + cycle detection) fires BEFORE the plan is emitted, so a failed preview matches a failed real run.

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

# Add a CSS design token (requires `fireforge furnace init` first; see the Furnace/Tokens section below)
fireforge token add --category 'Colors — General' -- --my-color 'light-dark(#fff, #000)'
```

Tokens live in the Furnace-managed tokens CSS file (`engine/browser/themes/shared/<binaryName>-tokens.css`), scaffolded by `fireforge furnace init` alongside `furnace.json`. The scaffold seeds a default set of categories (`Colors — General`, `Colors — Canvas`, `Colors — Experiment`, `Spacing`); add a category by hand as a `/* = My Category = */` comment inside the `:root { … }` block if you need another. `fireforge furnace init` also registers the tokens CSS path in `patchLint.rawColorAllowlist` so raw color literals inside it are not flagged by `fireforge lint`.

### Diff-scoped lint (`lint --since`)

`fireforge lint --since <git-rev>` tags each issue as `[introduced]` or `[cumulative]` based on whether its file changed since `<git-rev>`:

```bash
fireforge lint --since HEAD~1            # just the current commit
fireforge lint --since main              # everything since main
fireforge lint --since abc1234           # since a specific SHA
```

The summary line splits counts — e.g. `Lint: 2 introduced error(s), 0 introduced warning(s); 5 cumulative error(s), 1 cumulative warning(s)` — so triage of "did my diff introduce any of these?" is a one-glance check on a large patch series. Exit code still fails on any error (introduced or cumulative) unless `--only-introduced` is set; without `--since`, output is unchanged.

Pass `--only-introduced` together with `--since` to scope the exit code to issues the current diff introduced. Cumulative pre-existing errors still print, but do not fail lint — useful in CI when a branch's own diff is clean but the repo already carries unrelated errors from older patches:

```bash
fireforge lint --since main --only-introduced
```

The failure message reports how many cumulative errors were suppressed by the flag so a branch that passed only because of the flag still tells the operator what was hidden. Without `--since`, `--only-introduced` is rejected up-front — there is no introduced-vs-cumulative distinction to scope to.

### Post-build audit and auto-configure

`fireforge build` is a transactional step: after a successful mach build it audits the dist bundle against engine-relative paths touched since the last successful build, and warns per file that is packageable-by-convention (`.js`/`.mjs`/`.css`/`.ftl`/`.xhtml`/`app/profile/…`) but has no matching artifact or whose dist mtime is older than the source. Ends every build with a `Packaged: N updated, M stale, K missing, S skipped` summary. The audit is warn-only — it never fails a build that mach reported green.

The audit applies seven routing rules to suppress false positives that previously trained operators to ignore its warnings:

- **jar.mn registrations are authoritative.** When the source under audit is claimed by a `(source)` reference in an ancestor `jar.mn`, the audit walks the registration to compute the expected target path (e.g. `content/browser/mybrowser.js`) and probes the dist tree for a candidate whose absolute path ends with that suffix. Picking the correct artifact from a same-basename collision no longer depends on path-similarity scoring. If the registration target is missing from dist, the warning names the `jar.mn` entry so "registration is intact, packaging dropped the file" is distinguishable from "source is unregistered". This is the fix for the class of false positive where `engine/browser/base/content/<name>.js` (registered in `browser/base/jar.mn`) collided with an unrelated `browser/defaults/preferences/<name>.js` added by a separate patch; the heuristic could not distinguish them, so the audit falsely reported the correctly-packaged chrome resource as missing.
- **Build inputs are excluded.** `jar.mn`, `moz.build`, `moz.configure`, `Makefile.in`, and `mozbuild.in` are consumed by the build to produce chrome registrations / make targets but never themselves ship. They are skipped before the dist lookup, so editing them no longer fires a "missing packaged artifact" warning.
- **Same-basename collisions in `dist/` are disambiguated by trailing-segment overlap.** A branding override at `engine/browser/branding/<name>/content/aboutDialog.css` ships at `chrome/<area>/content/branding/aboutDialog.css`. A naive basename match would tie that against the unrelated upstream `chrome/<area>/content/browser/aboutDialog.css`; the audit now scores candidates by trailing path-segment match plus a small bonus for non-generic source segments (`branding`, the branding directory name) appearing in the candidate path, so re-rooted artifacts win over coincidentally-named ones. Applies only to sources that are not registered in jar.mn (registration-aware lookup runs first).
- **Unrelated same-basename hits never surface as "stale".** When the best-scoring candidate shares only the basename with the source and no meaningful intermediate segment (common on sparsely-populated `_tests/` trees where an upstream helper like `head.js` is the only same-basename file left from a prior build), the audit classifies the file as `missing` rather than emitting a misleading stale-comparison warning against the unrelated candidate. The warning enumerates every same-basename hit so the operator can see the full set of confounders at a glance — not just the scorer's pick.
- **Test sources are looked up under `_tests/`, not `dist/`.** Anything under `/test(s)/` directories, plus `browser_*.js` / `test_*.js` / `xpcshell.toml` / `browser.ini`, is resolved against the `_tests/` tree under the active `obj-*` directory. Mochitest and xpcshell harnesses copy registered tests there, never into the packaged bundle. Misses still warn — but they point at `_tests/`, directing the operator to `BROWSER_CHROME_MANIFESTS` / `XPCSHELL_TESTS_MANIFESTS` instead of `package-manifest.in`.
- **Test-path audits are gated on `_tests/all-tests.json`.** Plain `mach build` populates a partial `_tests/` subtree and stops — full test packaging only runs under `mach package-tests` / `mach test <target>` (or `fireforge test <name>`). The audit now checks for the `all-tests.json` marker written by the packaged-tests make target and silently skips test-path sources when the marker is absent, so every registered mochitest / xpcshell source no longer false-flags as "missing" on the common build-only path. Run `cd engine && ./mach package-tests` (or a scoped `fireforge test`) after a build to green-check test registrations.
- **Files inside an `if CONFIG[…]:` block in their owning `moz.build` are skipped on hosts where the gate is off.** Windows-only stubinstaller CSS on a macOS build, Darwin-only artwork on Linux, etc. The detection walks up to the closest `moz.build`, scans for the basename inside a Python-style indented `if CONFIG[…]:` block, and matches the gate against the host platform. Negation expressions are conservatively NOT treated as single-OS gates so a warning is never wrongly suppressed for a file that should ship on the current host. Subtrees packaged through platform-specific `Makefile.in` recipes that live outside the `moz.build` graph — `/stubinstaller/` (NSIS), `browser/installer/windows/`, `browser/installer/macosx/`, `browser/installer/linux/` — are also gated by path convention so branding stubinstaller CSS no longer warns on every non-Windows build.

The build also auto-runs `mach configure` before the mach build step when any `moz.build`, `moz.configure`, or `Makefile.in` changed since the last successful build. Prevents incremental builds from silently skipping work against a stale recursive-make backend. Emits a `Backend config changed; running mach configure first...` banner when it fires.

Mach build failures with known-cryptic mozbuild errors now print actionable hints. Example: a `JS_PREFERENCE_PP_FILES` entry with no `#filter` / `#expand` directives now prints `Hint: ...use JS_PREFERENCE_FILES instead, or add at least one #filter / #expand directive to the file.` alongside the raw mach traceback.

### Relocated workspaces: `fireforge build --rewrite-mozinfo`

When a workspace is moved to a new path (e.g. the project directory was renamed or relocated on disk), `obj-*/mozinfo.json` still records the old `topsrcdir` / `topobjdir`. The pre-flight detects the mismatch and aborts with a "delete and rebuild" instruction — correct but expensive; a fresh clean build typically runs ~20 minutes and discards ~14 GB of intact obj artefacts on a moved checkout.

`fireforge build --rewrite-mozinfo` offers a shortcut for the pure path-relocation case. The rewriter patches `topsrcdir` / `topobjdir` / `mozconfig` inside `mozinfo.json` to match the current checkout, then runs `mach configure` so the recursive-make backend regenerates against the corrected paths. No obj-\* scrubbing, no fresh compile.

The rewriter refuses any change it cannot prove safe:

- `mozinfo.json` must record both `topsrcdir` and `topobjdir`.
- `topobjdir` must resolve to `<topsrcdir>/<objDir>` — out-of-tree builds are rejected.
- The detected `obj-*` directory name must match the one recorded in mozinfo — if the objdir name itself changed, the configure shape changed and a full rebuild is required.
- `mozinfo.json` must be valid JSON describing an object.

On any refusal the command falls back to the original clean-rebuild guidance with the refusal reason appended, so an unsafe relocation is never silently misrepaired.

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

`fireforge furnace create --xpcshell` scaffolds an **xpcshell test harness** instead. Use this when the component's code path is storage-only, observer-driven, or module-loading logic that does not touch a `tabbrowser`. xpcshell runs headless without browser chrome, so forks without an upstream tab strip can still cover these paths. The scaffolder writes `test_<name>_packaged.js` + `xpcshell.toml` into `engine/browser/base/content/test/<binary-name>-xpcshell/<component-name>/` and prints a note: registration in `XPCSHELL_TESTS_MANIFESTS` is the operator's call (the moz.build that should own the entry depends on where the component actually lives). `fireforge register <path>/xpcshell.toml` surfaces the same guidance when run directly rather than silently routing to a browser.toml-shaped advice.

The scaffolded xpcshell test is a **packaging probe**, not a module-load test. Lit-based components import `chrome://global/content/vendor/lit.all.mjs`, which references `window` at module-load — xpcshell has no `window` global, so an earlier scaffold that used `ChromeUtils.importESModule` reliably failed with `ReferenceError: window is not defined` for every Lit-based fork component. Instead, the test reads `XCurProcD` (`Services.dirsvc.get("XCurProcD", Ci.nsIFile)`) and probes two candidate layouts per asset — `<AppDir>/chrome/global/elements/<name>.{mjs,css}` (unpacked `dist/bin/browser/`) and `<AppDir>/browser/chrome/global/elements/<name>.{mjs,css}` (macOS .app-bundle / some ESR layouts). Either match passes; only when both miss does the assertion fail, which is the actual "stale build / missing jar.mn entry" case. Functional UI assertions still belong in a browser-chrome mochitest (`--test-style=browser-chrome`); the scaffolded test carries an inline comment pointing to that path so the constraint is obvious before the operator extends it.

xpcshell has a chrome-URI boundary that is worth knowing before writing assertions: `chrome://global/*` (toolkit chrome) IS registered and resolvable from the harness, but `chrome://browser/*` (browser chrome) is NOT — even when `firefox-appdir = "browser"` is set in the xpcshell.toml, the manifest set xpcshell loads lags what the real browser loads, so `NetUtil.asyncFetch("chrome://browser/content/…")` can still fail with `NS_ERROR_FILE_NOT_FOUND` against an artifact that IS present in `obj-*/dist/`. Assertions that need browser chrome URIs belong in a browser-chrome mochitest (`furnace create --test-style=browser-chrome`).

The two flags can be combined — `--with-tests --xpcshell` writes both harnesses.

### Stale-build preflight on `fireforge test`

`fireforge test <path>` (without `--build`) now runs a preflight that diffs engine HEAD and the workdir against the last successful `fireforge build` (recorded at `.fireforge/last-build.json`). When packageable engine files have changed since that baseline, the command prints a single up-front warning naming the paths and pointing at `fireforge test --build`. This catches the class of failure where a newly scaffolded chrome resource or pref file is registered correctly but `obj-*/dist/` still holds the pre-edit bundle, so the test reads stale packaged artifacts and errors out with a cryptic `NS_ERROR_FILE_NOT_FOUND` inside xpcshell / mach test. The preflight is warn-only — a fork that rebuilt out-of-band (direct `./mach build`, IDE plugin, separate CI stage) is not blocked. Passing `--build` skips the preflight because the rebuild just refreshed the bundle.

### xpcshell appdir auto-injection on rebranded forks

`fireforge test` auto-resolves and injects `--app-path=<absolute>` into the underlying `mach test` invocation when the nearest `xpcshell.toml` sets `firefox-appdir = "browser"` and the active build's `appname` is anything other than `firefox`. Without this, every `resource:///modules/<name>.sys.mjs` import inside the harness throws `Failed to load resource:///modules/…` because the upstream xpcshell harness reads the appdir override under the appname-keyed manifest field (`<appname>-appdir`) — the literal `firefox-appdir = "browser"` directive is silently ignored on rebranded forks, `appPath` falls back to `xrePath`, and `resource:///` resolves one level above the real app root. The resolver walks each test path to its nearest manifest, reads `mozinfo.json` for the active appname, prefers any `<appname>-appdir` already in the manifest, and otherwise probes `<objDir>/dist/bin/<value>` and `<objDir>/dist/<bundle>.app/Contents/Resources/<value>` for the absolute target. Operator overrides via `--mach-arg=--app-path=…` always win and skip the resolver silently. Mismatches across multiple test paths and unresolvable manifest values surface as warnings rather than guesses, so triage reaches the underlying cause.

The durable fix is to add `<appname>-appdir = "browser"` alongside `firefox-appdir = "browser"` in the manifest — the harness then reads the appname-keyed value directly without auto-injection. The xpcshell appdir hint that fires when the symptom persists despite injection lists this option first.

### Smoke-run mode (`fireforge run --smoke-exit`)

`fireforge run --smoke-exit <seconds>` launches the real built browser, streams the merged console line-by-line, sends `SIGTERM` to the entire child process group at the deadline, and exits non-zero when any `JavaScript error:` / `console.error:` / `[JavaScript Error]` / `###!!! [Parent]` line surfaces inside the smoke window without matching an allowlist. Closes the headless-vs-real-chrome gap that previously forced agents to choose between `fireforge run` (no exit hook, hangs on a human) and `--headless` (does not load the chrome document, so chrome-window constructor errors stay invisible).

```bash
# Launch, wait 60s, exit 0 unless an unallowed error fired
fireforge run --smoke-exit 60

# Same, but ignore a known async-shutdown blocker we've already triaged
fireforge run --smoke-exit 60 --console-allow 'AsyncShutdown blocker timed out'

# Allowlist file (one regex per line, # comments and blanks skipped) + capture
fireforge run --smoke-exit 60 --console-allow-file scripts/smoke-allow.txt --capture-console smoke.log
```

Exit codes are wired distinct from `BUILD_ERROR`:

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Smoke window elapsed cleanly (or only allowlisted errors fired).       |
| 12   | One or more unallowed console errors fired inside the window.          |
| 13   | Browser exited non-clean before the window elapsed (launch-side fail). |

POSIX only — process-group semantics do not map cleanly onto Windows. A smoke window shorter than 30 s warns up-front because cold-start time alone can consume that budget on a debug build; `--capture-console <file>` mirrors the captured stream so post-exit inspection has the raw log without re-running.

The summary block reports two allowlist counters so operators can tell whether a pattern actually matched anything: `Allowlisted error hits (suppressed)` is the exit-contract number (errors that would have failed the window but were dropped by the allowlist), and `Allowlisted lines total` is the mental-model number (every console line that matched the allowlist, regardless of whether it was an error-class line). A non-zero `total` with a zero `suppressed` count means the allowlist patterns matched benign info/warn lines that never counted toward the exit contract to begin with.

### Furnace `--shared-ftl` for feature-scoped Fluent bundles

A feature with multiple components (e.g. an eight-component dock) typically wants one shared `.ftl` per feature rather than eight per-component stubs. `furnace create <tag> --localized --shared-ftl <chrome-uri>` participates in an existing feature-scoped bundle:

```bash
fireforge furnace create hominis-dock-button --localized --shared-ftl browser/hominis-dock.ftl
```

The generated `.mjs` calls `insertFTLIfNeeded("browser/hominis-dock.ftl")` instead of the per-component path. No `<tag>.ftl` stub is written. The `furnace.json` `custom` entry carries a new `sharedFtl` field so apply, validate, and remove all honour the participation:

- `furnace apply` does not copy a per-component `.ftl` into the FTL tree nor add a locale `jar.mn` entry — the shared file is registered by whoever owns the feature bundle.
- `furnace remove` early-returns from the locale `jar.mn` cleanup, so dropping our component's reference does not orphan the bundle for every other participant.
- `furnace validate`'s `missing-ftl` structural check is skipped — there is no per-component `.ftl` to require.

`--shared-ftl` implies `--localized`. `--no-localized + --shared-ftl` is rejected fast-fail. The value is interpolated verbatim into the generated template literal, so backticks, backslashes, and `${` are rejected at parse time. Setting `sharedFtl` does not auto-migrate previous per-component FTL state — flipping an existing component leaves the prior per-component entry in the engine tree and locale `jar.mn` until cleaned up explicitly.

### Furnace `keyboardCovered` for composed-button wrappers

`furnace validate`'s `no-keyboard-handler` rule is automatically suppressed when `@click` sits on a custom-element host whose `composes` lists a native-interactive child (e.g. `moz-button`, `moz-toggle`). The wrapper's click handler catches keyboard activation transitively because the inner element dispatches `click` on Enter/Space via the platform; a duplicate `@keydown` on the wrapper would either no-op or double-fire alongside the child's built-in path.

When the wrapped inner element is hand-authored or is a non-stock `moz-*` widget that does not appear in `composes`, the explicit `keyboardCovered: true` field on the component's `furnace.json` entry forces the same skip:

```json
"hominis-dock-button": {
  "description": "Dock button wrapper",
  "targetPath": "components/custom/hominis-dock-button",
  "register": true,
  "localized": false,
  "composes": ["moz-button"],
  "keyboardCovered": true
}
```

`keyboardCovered` is operator-asserted — it does not re-check the component, so it can be used to silence a genuine finding. Prefer adding the wrapped tag to `composes` when that field applies (it carries semantic value beyond a11y).

### Test escape valves

`fireforge test --mach-arg <arg>` (repeatable) forwards a single argument verbatim to `mach test` after FireForge-managed flags. Escape valve for upstream xpcshell/mochitest options FireForge does not model directly:

```bash
fireforge test browser/base/content/test/foo --mach-arg=--keep-going --mach-arg=--verbose
fireforge test browser/components/tests/unit/test_x.js --mach-arg=--app-path=/abs/override
```

Operator overrides for `--app-path` always win over the auto-injection described above.

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
