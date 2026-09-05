<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Configuration

`fireforge.json` at the project root holds the project's configuration, and
`furnace.json` holds component configuration. This file covers the settings
whose behavior needs more than a schema line, plus the environment variables
FireForge reads.

## `firefox`, the source pin

`firefox.version`, together with `firefox.product` and optionally
`firefox.sha256` and `firefox.candidate`, is the source pin that
`fireforge download` resolves an archive from. `fireforge source set` writes
it.

The pin lives in `fireforge.json` next to hand-maintained policy sections,
which is worth knowing when you revert that file. Running
`git checkout -- fireforge.json` after an accidental reformat also reverts an
uncommitted pin, and the tree is then building a different version than the
config claims.

### Archive integrity: `firefox.sha256` and `firefox.allowUnverifiedDownload`

Every fresh download is checked against Mozilla's published `SHA256SUMS` for
the release. A mismatch fails the download and discards the archive. The
check also fails closed when the published digest cannot be obtained at all:
a 404, a captive portal answering with an HTML page, a dropped connection, or
a timeout. TLS alone is thin trust for the artifact that becomes the git
baseline every patch is built on, and "the checksum host was unreachable" is
exactly the condition someone positioned on the network can arrange.

- `firefox.sha256` pins the digest. It takes precedence over the published
  file and is the right answer for reproducible builds and offline mirrors:
  obtain it out of band, and the download verifies with no network beyond the
  archive itself.
- `firefox.allowUnverifiedDownload: true` accepts a download when the
  published digest is unavailable, with a loud warning. This disables the
  integrity check for that case, so the archive is trusted on TLS alone. Use
  it only for a mirror you already trust, and prefer pinning `sha256`
  instead. A digest that is fetched and does not match is rejected either
  way. The setting is ignored when `sha256` is set.

`fireforge doctor` reports the pin beside what the checkout actually is (the
engine's own `browser/config/version.txt` and the version the last download
recorded) and warns when they disagree. It is a report, not a lock, since a
tree may legitimately be mid-migration. `product`, `sha256` and `candidate`
have no recorded counterpart on disk, so the check does not claim to have
verified them.

## External toolchains

Projects with generated asset prerequisites can declare opt-in
`externalToolchains`. `fireforge doctor` reports missing required tools as
errors and missing optional tools as warnings.

Seasonal branding on macOS, for example, can declare Apple's Icon Composer
tool at
`/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool`,
plus `actool` via `xcrun`, `sips`, and `iconutil`.

## `patchLint`

Per-patch lint type-checks plain Firefox JS against a built-in
Firefox-globals shim that tracks upstream WebIDL additions per release.

- `patchLint.checkJsExtraShim` adds members to the structured shim globals
  via TypeScript interface merging, for example
  `interface ChromeUtilsShim { newApi(): any }`.
- `patchLint.checkJsTestFiles: true` extends the pass to patch-owned test
  `.js` files (`browser_*`, `test_*`, `xpcshell_*`, and `/test/` paths). Each
  one is checked as its own small script-scope program against a loose
  built-in harness shim.
- `patchLint.checkJsTestShim` points at a project `.d.ts` whose typed
  declarations (a real `TestUtils` interface, say) override the loose
  baseline, so calls to harness members that do not exist fail at export
  time.
- `patchLint.prettier` (`'off'`, `'warning'` or `'error'`, default `'off'`)
  runs the project's configured Prettier over patch-owned `.sys.mjs`
  modules. It runs from inside `engine/`, so `engine/.prettierrc*` and
  `engine/.prettierignore` decide the outcome. The same command run from the
  repo root can report a false pass when the root `.prettierignore` excludes
  `engine/`. Prettier is resolved from `engine/node_modules`, then the
  project's, then `npx --no-install`. Left at `'off'`, formatting is out of
  scope for the per-patch tier, and no other tier checks `.sys.mjs`
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
  `500/750/900`, test `1200/1400/1600`). The merged triple has to satisfy
  `notice <= warning <= error`, which is validated at config load. Under
  the recommended gate posture `--max-warnings 0`, the `warning` band
  is a hard failure rather than a soft limit, which is what these thresholds
  exist to let you move.

## `patchPolicy`

`patchPolicy.ranges` makes `patch compact` range-aware, so closing ordinal
gaps does not move a patch out of the band its category owns.

## `test`

`test.canaryPath` and `test.canaryTimeoutSeconds` supply the defaults for
`fireforge test --canary`. See [`testing.md`](testing.md).

## `buildAudit`

The post-build packaging audit is warn-only. Most of what it would otherwise
report as "missing packaged artifact" is classified away from the structure
of the tree itself: an unselected `--with-branding` tree read from the
generated `engine/mozconfig`, a directory reached only through a
platform-gated `DIRS +=` in an ancestor `moz.build`, a Storybook
`*.stories.mjs`. One case cannot be derived from the tree: a source that is
deliberately never packaged, such as a type-only mirror whose header says it
is never loaded. Declare those:

```json
{
  "buildAudit": {
    "unpackaged": [
      {
        "path": "browser/base/content/hominis-tile-host-types.js",
        "reason": "Type-only mirror of the tile host, never loaded, and no jar.mn entry by design."
      }
    ]
  }
}
```

- `path` is engine-relative. A `*` may glob within one path segment. `**` is
  refused, because a subtree carve-out is how a reviewed exception quietly
  becomes a blanket one.
- `reason` is required and must be non-empty. This is the one audit class
  FireForge cannot verify against the tree, so the declaration is the
  evidence. By the time someone reads it, an unexplained carve-out is
  indistinguishable from a mistake.
- Admitted paths are listed in the audit output, never silenced. The notice
  reads `admitted as unpackaged by buildAudit.unpackaged "<path>"` followed
  by the declared reason.
- A declared path that does resolve to a packaged artifact is reported as a
  stale carve-out rather than suppressed, because the declaration asserts a
  fact about the tree that is no longer true.
- A declaration matching nothing that changed in a given run says nothing.
  Unlike `--expect-unmanaged`, whose unmet entries are reported because it is
  a per-invocation flag list, this is a standing list checked only against
  the files that happened to change, so "not met" is the normal case.

The `Packaged:` summary line names each non-zero skip class with its count,
so a run that dismissed four unselected-branding files reads differently from
one that dismissed four unregistered sources.

## Design tokens

Tokens are managed with `fireforge token add`. `fireforge token list` and
`fireforge token show` report what is already there.

- `--create-category` declares a new category banner and inserts the token in
  one step. It cannot be combined with `--variant`: author the category with
  the base token first, then add each variant.
- `--category` is required for a base declaration and optional under
  `--variant`, where the declaration is routed into a `:root<selector>` block
  and never into a category section. It is still validated when supplied.
- `--variant` takes the same selector grammar the block matcher understands:
  one attribute fragment (`[data-private]`, `[data-skin=precision]`), a run
  of them (`[data-skin=precision][data-theme=dark]`), and an optional
  pseudo-class tail (`[data-skin=precision]:not([data-private])`). Names and
  values must be identifier-safe, and `=value` is normalized to `="value"`. A
  variant naming a qualifier matches only a block carrying that qualifier.
  One without a qualifier still matches a qualified block, and the write says
  so.
- `--mode override` mirrors into both `:root[data-theme="dark"]` and
  `:root[data-theme="light"]`. A qualified block such as
  `:root[data-theme="light"]:not([data-private])` is matched and written
  through, with a warning naming the selector. The qualifier carries meaning,
  but silently skipping half the mirror is the worse failure.
- A token already present in the target block is reported with its location
  (`already exists in :root[…] (line N), unchanged`) rather than as a bare
  no-op.

### Reading the token file

`token add --category` refuses a category that the tokens CSS does not
declare, so `token list` exists to name the categories without you
hand-parsing a `= Category =` banner out of the file.

- `fireforge token list [--category <name>] [--json]` reports each category
  banner with the tokens declared under it, in file order. Declarations above
  the first banner are reported under `(no category)` rather than dropped,
  and a banner with no tokens is still listed, since `token add` accepts it.
  An unknown `--category` is refused by naming the ones that exist, because a
  filter that printed nothing would read as "this category is empty".
- `fireforge token show <token-name> [--json]` reports the owning category
  and the value the token takes in every block that declares it: the base
  `:root`, the dark `@media` mirror, and each `:root[variant]`, with the line
  of each. The leading `--` is optional, and if you include it, pass the `--`
  separator first (`fireforge token show -- --my-token`).

Only the base `:root` block owns a token, so `token list` reports it once.
The dark and variant blocks mirror it and appear in `token show`.

## Smoke runs

For unattended smoke checks, `fireforge run --smoke-exit <s> --headless`
launches the browser headless. A headed smoke window on a shared desktop
absorbs live input, which contaminates the console capture, so headed
non-CI launches print a warning saying so. Exit codes 12 and 13 separate a
console regression from a launch failure. See
[`exit-codes.md`](exit-codes.md).

## Lock waits

Every FireForge command that mutates the engine takes the engine-session
lock, and some take a second subsystem lock as well. Contention fails fast
after about a second by default.

`--wait-lock [seconds]` (bare flag means 60, valid range 1 to 3600) replaces
that with a bounded wait, and the budget covers every lock the command takes.
For `furnace apply`, `deploy` and `sync` that means the furnace lock as well
as the engine-session lock. While waiting, a progress line roughly every 5
seconds identifies the holder by PID, command and start time.

Commands that take no lock accept `--wait-lock` and ignore it, so a scripted
sequence can append the flag everywhere without a usage error killing the
run.

`FIREFORGE_WAIT_LOCK=<seconds>` applies the same budget to every command in a
session, using the same bounds as the flag. It is the only way to give a
budget to the furnace mutators that declare no flag (`create`, `remove`,
`rename`, `refresh`, `scan`, `override`, `chrome-doc`, and the rest). An
explicit `--wait-lock` always wins.

`fireforge status --lock` reports the current holder and queue depth.

## Environment variables

| Variable                             | Effect                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREFORGE_WAIT_LOCK`                | Session-wide lock wait budget in seconds (1 to 3600). See above.                                                                        |
| `FIREFORGE_MAX_UNTRACKED_FILES`      | Per-directory cap when expanding collapsed untracked directories in `status` (default 5000). A non-positive value warns and is ignored. |
| `FIREFORGE_GIT_ADD_TIMEOUT_MS`       | Timeout for the monolithic `git add -A` baseline pass (default 10 min). For slow or loaded filesystems.                                 |
| `FIREFORGE_GIT_ADD_CHUNK_TIMEOUT_MS` | Timeout for the chunked `git add -- <dir>` fallback (default 30 min). Paired with the above.                                            |

`CLAUDECODE` is read by mozbuild, not by FireForge. `fireforge test
--full-output` unsets it for test dispatches only. See
[`testing.md`](testing.md#output-verbosity).
