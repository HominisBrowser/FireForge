<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Configuration

`fireforge.json` at the project root is the project's configuration;
`furnace.json` holds component configuration. This file covers the settings
whose behaviour needs more than a schema line, plus the environment variables
FireForge reads.

## `firefox` — the source pin

`firefox.version` (with `firefox.product`, and optionally `firefox.sha256` and
`firefox.candidate`) is the source pin `fireforge download` resolves an archive
from. `fireforge source set` writes it.

The pin lives in `fireforge.json` beside hand-maintained policy sections, which
is worth knowing when reverting that file: `git checkout -- fireforge.json`
after an accidental reformat also reverts an **uncommitted** pin, and the tree
is then building a different version than the config claims.

`fireforge doctor` reports the pin beside what the checkout actually is — the
engine's own `browser/config/version.txt` and the version the last download
recorded — and warns when they disagree. It is a report, not a lock: a tree
may legitimately be mid-migration. `product`, `sha256` and `candidate` have no
recorded counterpart on disk, so the check does not claim to have verified
them.

## External toolchains

Projects with generated asset prerequisites can declare opt-in
`externalToolchains`. `fireforge doctor` reports missing **required** tools as
errors and missing **optional** tools as warnings.

Seasonal branding on macOS, for example, can declare Apple's Icon Composer
tool at
`/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool`,
plus `actool` via `xcrun`, `sips`, and `iconutil`.

## `patchLint`

Per-patch lint type-checks plain Firefox JS against a built-in Firefox-globals
shim that tracks upstream WebIDL additions per release.

- `patchLint.checkJsExtraShim` adds members to the structured shim globals via
  TypeScript interface merging, e.g.
  `interface ChromeUtilsShim { newApi(): any }`.
- `patchLint.checkJsTestFiles: true` extends the pass to patch-owned test
  `.js` files (`browser_*` / `test_*` / `xpcshell_*` and `/test/` paths). Each
  is checked as its own small script-scope program against a loose built-in
  harness shim.
- `patchLint.checkJsTestShim` points at a project `.d.ts` whose typed
  declarations (e.g. a real `TestUtils` interface) override the loose
  baseline, so calls to nonexistent harness members fail at export time.
- `patchLint.prettier` (`'off'` | `'warning'` | `'error'`, default `'off'`)
  runs the project's configured Prettier over patch-owned `.sys.mjs`
  modules. It runs from inside `engine/`, so `engine/.prettierrc*` and
  `engine/.prettierignore` decide — the same command run from the repo root
  can report a false pass when the root `.prettierignore` excludes
  `engine/`. Prettier is resolved from `engine/node_modules`, then the
  project's, then `npx --no-install`. **Left `'off'`, formatting is out of
  scope for the per-patch tier**; no other tier checks `.sys.mjs`
  formatting either.
- `patchLint.fileSizeThresholds` tunes the `file-too-large` line counts per
  file class:

  ```json
  {
    "patchLint": {
      "fileSizeThresholds": {
        "general": { "notice": 500, "warning": 800, "error": 900 },
        "test": { "warning": 1500 }
      }
    }
  }
  ```

  Every field is optional and merges over the defaults (general
  `500/750/900`, test `1200/1400/1600`). The merged triple must satisfy
  `notice <= warning <= error`, which is validated at config load. Note that
  under the recommended gate posture `--max-warnings 0` the `warning` band is
  a hard failure, not a soft limit — which is what these thresholds exist to
  let you move.

## `patchPolicy`

`patchPolicy.ranges` makes `patch compact` range-aware, so closing ordinal
gaps does not move a patch out of the band its category owns.

## `test`

`test.canaryPath` and `test.canaryTimeoutSeconds` supply the defaults for
`fireforge test --canary`. See [`testing.md`](testing.md).

## Design tokens

Tokens are managed with `fireforge token add`.

- `--create-category` declares a new category banner and inserts the token in
  one step. It is incompatible with `--variant`; author the category with the
  base token first, then add each variant.
- `--category` is required for a base declaration and optional under
  `--variant`, where the declaration is routed into a `:root<selector>` block
  and never into a category section. It is still validated when supplied.
- `--variant` takes the same selector grammar the block matcher understands:
  one attribute fragment (`[data-private]`, `[data-skin=precision]`), a run of
  them (`[data-skin=precision][data-theme=dark]`), and an optional pseudo-class
  tail (`[data-skin=precision]:not([data-private])`). Names and values must be
  identifier-safe, and `=value` is normalized to `="value"`. A variant naming a
  qualifier matches only a block carrying that qualifier; one without a
  qualifier still matches a qualified block, and the write says so.
- `--mode override` mirrors into both `:root[data-theme="dark"]` and
  `:root[data-theme="light"]`. A qualified block such as
  `:root[data-theme="light"]:not([data-private])` is matched and written
  through, with a warning naming the selector — the qualifier is
  semantically load-bearing, but silently skipping half the mirror is the
  worse failure.
- A token already present in the target block is reported with its location
  (`already exists in :root[…] (line N), unchanged`) rather than a bare
  no-op.

## Smoke runs

For unattended smoke checks, `fireforge run --smoke-exit <s> --headless`
launches the browser headless. A headed smoke window on a shared desktop
absorbs live input, which contaminates the console capture — headed non-CI
launches print a warning saying so. Exit codes 12 and 13 separate a console
regression from a launch failure; see [`exit-codes.md`](exit-codes.md).

## Lock waits

Every FireForge command that mutates the engine takes the engine-session lock,
and some take a second subsystem lock as well. Contention fails fast after
about a second by default.

`--wait-lock [seconds]` (bare flag = 60, valid 1–3600) replaces that with a
bounded wait, and the budget covers **every** lock the command takes — for
`furnace apply`/`deploy`/`sync` that means the furnace lock as well as the
engine-session lock. While waiting, a progress line roughly every 5 seconds
identifies the holder by PID, command and start time.

Commands that take no lock accept `--wait-lock` and ignore it, so a scripted
sequence can blanket-append the flag without a usage error killing the run.

`FIREFORGE_WAIT_LOCK=<seconds>` applies the same budget to every command in a
session, using the same bounds as the flag. It is the only way to give a
budget to the furnace mutators that declare no flag (`create`, `remove`,
`rename`, `refresh`, `scan`, `override`, `chrome-doc`, …). An explicit
`--wait-lock` always wins.

`fireforge status --lock` reports the current holder and queue depth.

## Environment variables

| Variable                             | Effect                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREFORGE_WAIT_LOCK`                | Session-wide lock wait budget in seconds (1–3600). See above.                                                                           |
| `FIREFORGE_MAX_UNTRACKED_FILES`      | Per-directory cap when expanding collapsed untracked directories in `status` (default 5000). A non-positive value warns and is ignored. |
| `FIREFORGE_GIT_ADD_TIMEOUT_MS`       | Timeout for the monolithic `git add -A` baseline pass (default 10 min). For slow or loaded filesystems.                                 |
| `FIREFORGE_GIT_ADD_CHUNK_TIMEOUT_MS` | Timeout for the chunked `git add -- <dir>` fallback (default 30 min). Paired with the above.                                            |

`CLAUDECODE` is read by mozbuild, not by FireForge, and `fireforge test
--full-output` unsets it for test dispatches only — see
[`testing.md`](testing.md#output-verbosity).
