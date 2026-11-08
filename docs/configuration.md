<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Configuration

`fireforge.json` at the project root holds the project's configuration, and
`furnace.json` holds component configuration ([`furnace.md`](furnace.md)). This
file covers the settings whose behavior needs more than a schema line, plus the
environment variables FireForge reads.

## Validation

`fireforge.json` is validated whenever a command loads it. An unknown key at the
root or inside any block is refused, with a "did you mean" hint for a near miss:
a misspelt gate (`patchLint.prettir`) would otherwise leave the gate off and the
run green. `binaryName` must match `^[a-z][a-z0-9-]*$`; `name` and `vendor`
must not contain control characters.

`fireforge config <key> <value>` validates the whole document before writing.
`--force` only lifts the check against the known-path list; it never writes an
invalid value or an unknown key. `fireforge source set`, `config` and
`furnace init` rewrite only the values that change, so indentation, key order
and one-line objects stay as they are.

Every Git call FireForge makes ignores global and system configuration, global
excludes, hooks, attributes files and commit signing, and pins `diff.noprefix`,
`diff.mnemonicPrefix`, `color.ui`, `diff.renames` and `diff.algorithm`. Generated
patch bytes therefore do not depend on who ran the command. Repository-local
configuration (`.git/config`, `.git/info/exclude`) still applies.

## `firefox`: the source pin

| Key                               | Type    | Default | Effect                                                                                  |
| --------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------- |
| `firefox.version`                 | string  | none    | Release to download, such as `153.4.0esr`.                                              |
| `firefox.product`                 | string  | none    | Mozilla product, such as `firefox-esr`.                                                 |
| `firefox.sha256`                  | string  | unset   | Pins the archive digest. Wins over the published `SHA256SUMS`; works offline.           |
| `firefox.candidate`               | string  | unset   | Release-candidate build directory (`build2`), for pre-release verification.             |
| `firefox.allowUnverifiedDownload` | boolean | `false` | Accept a download when the published digest cannot be fetched. Ignored if `sha256` set. |

`fireforge source set` writes the pin; reverting `fireforge.json` with Git also
reverts an uncommitted pin.

Every fresh download is checked against Mozilla's published `SHA256SUMS`. A
mismatch discards the archive. Failing to obtain the digest at all (404, captive
portal, timeout) also fails the download, unless `allowUnverifiedDownload` is
set, which trusts the archive on TLS alone and warns. Prefer pinning `sha256`.
Cache metadata records how each archive was verified; archives accepted without
verification are re-checked against the current policy before reuse.

`fireforge doctor` compares the pin with the engine's `browser/config/version.txt`
(a trailing `esr` is dropped for that comparison) and with the version the last
download recorded, and warns on a mismatch. It is a report, not a lock.
`product`, `sha256` and `candidate` have no on-disk counterpart and are not
verified by it.

## `externalToolchains`

Declares tools a project's generated assets need, such as Apple's `ictool`,
`actool` (via `xcrun`), `sips` and `iconutil` for seasonal branding.
`fireforge doctor` reports a missing required tool as an error and an optional
one as a warning.

On macOS, `doctor` also links a trivial C program with the bootstrapped clang
(`~/.mozbuild/clang`, or under `MOZBUILD_STATE_PATH`) against the SDK
`engine/mozconfig` selects with `--with-macos-sdk` (else `xcrun --show-sdk-path`).
On failure it warns with clang's first error and lists the installed SDKs. It does
nothing on other platforms or before a clang is bootstrapped.

## `patchLint`

Per-patch lint type-checks patch-owned plain JS against a built-in
Firefox-globals shim (most globals are `any`; `Cu` is typed to the members of
`nsIXPCComponents_Utils`). The same shim backs `fireforge typecheck`.

| Key                          | Type / values                  | Default         | Effect                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkJs`                    | boolean                        | off             | Type-check patch-owned plain JS.                                                                                                                                                                                                                                                                                                                       |
| `checkJsStrict`              | boolean (needs `checkJs`)      | off             | `strict` plus `noImplicitAny`.                                                                                                                                                                                                                                                                                                                         |
| `checkJsCompilerOptions`     | object (needs `checkJsStrict`) | none            | Per-flag overrides after the strict preset: the booleans `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `noImplicitThis`, `useUnknownInCatchVariables`, `strictPropertyInitialization`, `noUnusedLocals`, `noUnusedParameters`, and `paths` (pattern to string-array targets, at most one `*` per pattern). Other keys are refused. |
| `checkJsExtraShim`           | string                         | none            | Adds members to the shim globals by interface merging, e.g. `interface ChromeUtilsShim { newApi(): any }`.                                                                                                                                                                                                                                             |
| `checkJsTestFiles`           | boolean                        | off             | Also check patch-owned test scripts (`browser_*`, `test_*`, `xpcshell_*`, `/test/`), each as its own program.                                                                                                                                                                                                                                          |
| `checkJsTestShim`            | path to a `.d.ts`              | none            | Typed harness declarations that override the loose built-in baseline.                                                                                                                                                                                                                                                                                  |
| `litTypes`                   | boolean (needs `checkJs`)      | off             | Types Lit in per-patch programs. Set it to the same value as `typecheck.litTypes`.                                                                                                                                                                                                                                                                     |
| `prettier`                   | `off`, `warning`, `error`      | `off`           | Run the project's Prettier over patch-owned `.sys.mjs`, from inside `engine/` (so `engine/.prettierrc*` decide).                                                                                                                                                                                                                                       |
| `rawColorAllowlist`          | string[]                       | none            | Paths (exact or basename) exempt from the raw-color check, normally the token file.                                                                                                                                                                                                                                                                    |
| `forwardRegistration`        | `support-files`, `extended`    | `support-files` | Carriers the `forward-registration` queue rule checks (below).                                                                                                                                                                                                                                                                                         |
| `fileSizeThresholds`         | object                         | see below       | `file-too-large` line counts per class.                                                                                                                                                                                                                                                                                                                |
| `fileSizeMetric`             | `raw`, `code`                  | `raw`           | `raw` counts every line; `code` counts non-blank, non-comment lines (a file acorn cannot tokenize falls back to raw and gets a `file-size-unparsed` notice).                                                                                                                                                                                           |
| `patchSizeThresholds`        | object                         | see below       | `large-patch-lines` and `large-patch-files` per tier.                                                                                                                                                                                                                                                                                                  |
| `patchSizeMetric`            | `diff`, `addedCode`            | `diff`          | `diff` counts every non-binary diff line; `addedCode` counts only added non-blank, non-comment lines judged on the post-image.                                                                                                                                                                                                                         |
| `patchSizeRegistrationFiles` | glob[]                         | none            | Files counted by neither patch-size rule, e.g. `["jar.mn", "moz.build", "*.toml"]`. A glob without `/` matches basenames.                                                                                                                                                                                                                              |
| `tokenScales`                | object[]                       | unset           | Puts CSS property families on a token scale (below).                                                                                                                                                                                                                                                                                                   |

With `prettier` on, a missing formatter, a failed invocation or an unrecognized
result is a finding at the configured severity; it never reads as a clean check.
Prettier is resolved from `engine/node_modules`, then the project's installed
formatter; there is no download fallback. With it `off`, no tier checks
`.sys.mjs` formatting.

### `forwardRegistration`

`support-files` checks test-manifest `support-files` lines that name a file only
a later patch creates. `extended` also checks jar.mn pair lines, moz.build path
tokens, test-manifest section headers and `head`, and `customElements.js`
`chrome://` URLs resolved through the queue's jar.mn lines. A line that cannot
be resolved without the build system (`%`, `@AB_CD@`, `**`, `!`, a path leaving
the tree, an unpackaged chrome URL) is left alone. Each finding prints the
`patch staged-dependency --add --kind registration` command to run and carries a
`stagedDeclarations` entry, so a `lint --per-patch --report` file can be applied
with `patch staged-dependency <patch> --add --from <report>`. It is opt-in
because an unchecked queue can carry many such edges.

### Size thresholds

Every field is optional and merges over the defaults; each merged triple must
satisfy `notice <= warning <= error` (checked at load). Under `--max-warnings 0`
the `warning` band fails the run; a `notice` never does.

```json
{
  "patchLint": {
    "fileSizeThresholds": { "general": { "warning": 800 }, "test": { "warning": 1500 } },
    "patchSizeThresholds": {
      "general": { "lines": { "warning": 2000 }, "files": { "warning": 12 } },
      "branding": { "files": { "error": 90 } }
    }
  }
}
```

| Rule                        | general           | test               | branding             |
| --------------------------- | ----------------- | ------------------ | -------------------- |
| `file-too-large` (lines)    | 500 / 750 / 900   | 1200 / 1400 / 1600 | n/a                  |
| `large-patch-lines`         | 800 / 1500 / 3000 | 1500 / 3000 / 6000 | 8000 / 18000 / 30000 |
| `large-patch-files` warning | above 5           | above 5            | above 60             |

`files` has no notice or error band unless you set one. The `branding` tier
applies to a patch whose files all sit under `browser/branding/` (plus
`browser/moz.configure` and `browser/confvars.sh`) or one marked
`"tier": "branding"` in `patches.json` (`re-export --tier branding`). A patch of
only tests takes the `test` tier and wins over branding. Under `addedCode`, a
general-tier patch carrying tests counts test files against the test tier and the
rest against the general tier, each with its own finding.

### `tokenScales`

In every CSS file a patch creates, a declaration of a governed property must
resolve to the scale, or `token-scale` (an error) fires. Files a patch only
modifies are not checked; a line carrying `fireforge-ignore: token-scale` is
skipped; descriptor at-rules (`@font-face`, `@property`, `@page` and similar) are
not judged.

```json
{
  "patchLint": {
    "tokenScales": [
      {
        "properties": ["gap", "padding*", "margin*"],
        "prefix": "--brand-space-",
        "allowLiterals": ["0", "auto", "*%", "1px"],
        "allow": ["--brand-page-padding"]
      },
      { "properties": ["z-index"], "prefix": "--brand-z-" }
    ]
  }
}
```

A value must be a `var()` of a `prefix` token or an `allow` name (exact or
`*`-suffixed), a literal matching `allowLiterals` (`*` is a wildcard), or a
CSS-wide keyword. A `var()` fallback is held to the same scale; `calc()`, `min()`,
`max()` and `clamp()` are transparent.

| Scale key       | Effect                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `properties`    | Exact names or `*`-suffixed prefixes the scale governs.                                                                                                      |
| `prefix`        | A token prefix, or a list of them.                                                                                                                           |
| `allow`         | Extra names a `var()` may use.                                                                                                                               |
| `allowLiterals` | Literals accepted anywhere.                                                                                                                                  |
| `allowInCalc`   | Literals accepted only inside a math function, such as a unitless multiplier.                                                                                |
| `offsetCap`     | Px a declaration may subtract from the scale's tokens inside a math function, summed per declaration.                                                        |
| `exclude`       | Engine-relative globs of files the scale does not govern.                                                                                                    |
| `minFiles`      | Fewest patch-created stylesheets that must declare a governed property; under it `token-scale-vacuous` fails the queue. A `--patches` run does not judge it. |
| `allowValues`   | Reviewed `{ property, value, reason }` declarations accepted as written; `property` must be governed, `reason` is required.                                  |

An unknown key in a scale is refused.

## `typecheck`

| Key                              | Effect                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `typecheck.projects`             | jsconfig files `fireforge typecheck` checks as whole projects.                               |
| `typecheck.extraShim`            | Declarations added to the Firefox-globals shim for every project.                            |
| `typecheck.projectOverrides`     | The same, per project. A key matches the project by the file it names, relative or absolute. |
| `typecheck.litTypes`             | Types Lit in the shim (default off, below).                                                  |
| `typecheck.undefinedIdentifiers` | Reporting of undefined identifiers per project.                                              |

When `patchLint.checkJs` is on, `typecheck` also runs the per-patch pass that
`export` enforces, so green types mean export-clean types. `--project <path>`
checks one jsconfig with the block's other settings. Each run builds a fresh
program over the complete file set; a jsconfig's `incremental` and
`tsBuildInfoFile` are ignored and nothing is written under `engine/`.
`--no-cache` is accepted and ignored. `--source-files` (authored mode) takes file
paths and directory prefixes of captured source; an entry matching nothing is
refused.

The two passes see different programs. The project pass checks each project's
files with all its roots. A per-patch program checks a patch-created `.sys.mjs`
module together with the queue's other patch-owned modules, or a patch-created
test script alone. Patch-modified upstream files, widget `.mjs` and chrome scripts
are not checked per patch. `fireforge typecheck --explain <file>` runs no check
and prints both views of one file: each project's roots, `litTypes`, effective
shim and `undefinedIdentifiers`, and the per-patch program, its heads, the
modules its imports resolve to and each `resource:`/`chrome:` import's target or
`any`. The file may be relative to the project or to `engine/`, or absolute.

A test script's `resource:///` and `chrome://` imports resolve to modules the
queue creates up to the test's own patch; later-patch modules, upstream modules
and ambiguous basenames type as `any`, as does a type-member reference through
such an import. In the project pass that reference is an error unless a jsconfig
`paths` entry resolves the URL, as Furnace maintains for
`chrome://global/content/elements/` ([`furnace.md`](furnace.md#typed-cross-module-imports)).
`TS2305` and `TS2306` are reported when the specifier resolved to a patch-owned or
`paths`-mapped file, and suppressed when it fell onto the shim's `resource:*` or
`chrome:*` modules. Both passes declare Gecko DOM `isInstance` predicates with
instance narrowing and `MouseEvent.MOZ_SOURCE_PEN`.

### Lit types

`litTypes: true` types `LitElement` and the helpers of
`chrome://global/content/vendor/lit.all.mjs`, and `MozLitElement` of
`chrome://global/content/lit-utils.mjs`, with closed member lists, so a misspelt
member of a widget is an error. Template helpers and directives stay loose. It is
off by default because a reactive property declared only in `static properties`
or `static queries` then needs a declaration. A query getter is declared by
casting the base to the global `MozLitElementWith<Extra>`:

```js
const Base = /** @type {MozLitElementWith<{ input: HTMLInputElement }>} */ (MozLitElement);
export class MozSearch extends Base {
  static queries = { input: 'input' };
}
```

Without `litTypes`, `MozLitElementWith<Extra>` is `any`, so the same source checks
either way. A project shim can add members by merging `LitElementShimMembers`; a
jsconfig `paths` entry mapping these URLs to real sources takes precedence.

## `patchPolicy`

| Key                              | Default | Effect                                                                                                                                                                                                              |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchPolicy.ranges`             | none    | Order bands by category; `patch compact` keeps a patch inside its band.                                                                                                                                             |
| `patchPolicy.requireDescription` | `false` | An empty patch description is a violation.                                                                                                                                                                          |
| `patchPolicy.allowGaps`          | none    | With `false`, orders are contiguous within a range. Use `patch retire` to leave without a gap and `patch reserve` to hold an order a peer has claimed ([`patch-workflow.md`](patch-workflow.md#queue-maintenance)). |

### Registration-only rules

Four opt-in rules read patch bodies. `verify` and `lint --per-patch` report them
(as `patch-policy/<code>` in lint) at the severity `mutationMode` implies;
mutating commands do not evaluate them.

```json
{
  "patchPolicy": {
    "addOnlyMarker": "brand",
    "upstreamAllowlist": [
      "browser/moz.configure",
      { "path": "**/jar.mn", "addOnly": true },
      { "path": "**/moz.build", "addOnly": true }
    ],
    "scopeRules": [
      { "filenamePattern": "-tests\\.patch$", "files": ["**/test/**", "**/tests/**", "**/*.toml"] }
    ],
    "verifyDocumentPaths": true
  }
}
```

- `upstreamAllowlist` names, as globs, the upstream files a non-reserved patch
  may modify (`upstream-allowlist`). A file is upstream when no queue patch
  creates it. Patches in a `reservedRanges` band are governed by their own
  entry. Globs are anchored engine-relative paths: `*` stays within a segment,
  `**` spans segments.
- An entry with `addOnly: true` (`add-only`) lets a patch only add lines, each
  non-blank added line containing the marker (the entry's `marker`, else
  `addOnlyMarker`, case-insensitive); deleting the file or changing it as
  binary is refused. Any add-only entry matching a file makes it add-only.
- An add-only entry's `retiredPaths` lists paths whose registration lines a patch
  may remove (plain substring match). Other removals still fail. Without
  `addOnly` the key is refused.
- `scopeRules` limits patches selected by `category`, `filenamePattern` (a regular
  expression over the filename), or both, to the files its globs name (`scope`).
- `verifyDocumentPaths: true` requires each reserved allowlist entry's `adr` and
  `documentation` paths to exist (`reserved-document-missing`).

## `test`

| Key                         | Values                    | Default     | Effect                                                                                                     |
| --------------------------- | ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `test.canaryPath`           | engine-relative path      | none        | Default for `fireforge test --canary`.                                                                     |
| `test.canaryTimeoutSeconds` | number                    | none        | No-output ceiling for the canary.                                                                          |
| `test.reapOrphans`          | `report`, `reap`, `owned` | `report`    | What happens to harness helpers a killed run left behind (below). Source mode requires `owned`.            |
| `test.mochitestPorts`       | `fixed`, `auto`           | `fixed`     | `auto` lets a run proceed while a mochitest or Marionette port is held by something else (`--auto-ports`). |
| `test.lockMode`             | `exclusive`, `shared`     | `exclusive` | `shared` lets build-less runs without a negative control and with auto ports overlap (`--shared-lock`).    |
| `test.furnaceApply`         | `all`, `reached`, `none`  | `all`       | Which components `test --build` deploys first (`--furnace-apply`).                                         |

The preflight census reports a surviving harness helper and never signals it. A
helper is terminated only on a record of its identity: by the teardown of the run
that recorded it, or, under `reap`, `owned` or `--reap-orphans`, by the next run
once the recording FireForge process is gone, which stamps `orphans-reaped=<n>`
on the verdict line. A survivor no record names is left alone with a warning.
See [`testing.md`](testing.md).

## `history`

`history.path` (default `.fireforge/history.jsonl`) is where FireForge appends its
patch history: one JSON object per structural patch operation. It is an audit
trail and is never read back. Records carry `invocationId`, `pid`, `ppid` and,
when `FIREFORGE_SESSION_ID` is set, `sessionId`. A log at
`patches/.fireforge-history.jsonl` is moved to `history.path` on the next append
(records merged if both exist); set `history.path` to that location to keep it
there.

## `buildAudit`

The post-build packaging audit is warn-only and classifies most "missing packaged
artifact" cases from the tree itself. A source that is deliberately never packaged
must be declared:

```json
{
  "buildAudit": {
    "unpackaged": [
      { "path": "browser/base/content/host-types.js", "reason": "Type-only mirror, never loaded." }
    ]
  }
}
```

- `path` is engine-relative; `*` globs within one segment and `**` is refused.
- `reason` is required and non-empty: the declaration is the only evidence.
- Admitted paths are listed in the audit output with their reason, never silenced.
- A declared path that does resolve to a packaged artifact is reported as a stale
  carve-out. A declaration matching nothing that changed says nothing.

## `check`

`fireforge check` runs six built-in steps (`status`, `verify`, `lint`,
`typecheck`, `furnace-validate`, `token-coverage`) and then the project's own
commands. Every field is optional:

```json
{
  "check": {
    "skip": ["token-coverage"],
    "status": { "failOn": ["unmanaged", "conflict"], "allow": ["branding"], "failOnUnknown": true },
    "maxWarnings": { "lint": 0, "furnace": 0 },
    "extraSteps": [
      { "name": "policy-audit", "command": "npm run audit:policy", "timeout": 600 },
      {
        "name": "invariants",
        "command": "node check-invariants.mjs",
        "cwd": "tools",
        "footprint": { "static": true }
      }
    ]
  }
}
```

| Key                            | Effect                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip`                         | Built-in steps this project never runs. `typecheck` also skips without a `typecheck` block, `furnace-validate` without `furnace.json`.                                                                                                                                                                                       |
| `status`                       | The status step's `--fail-on`, `--allow`, `--fail-on-unknown` ([`patch-workflow.md`](patch-workflow.md#ci-enforcement)). Invalid policy is a config error.                                                                                                                                                                   |
| `maxWarnings.lint`, `.furnace` | `--max-warnings` for `lint --per-patch` and `furnace validate`. `prove` (`static`, `check`) and `authored lint` hold the same line: `authored lint` exits nonzero over `maxWarnings.lint`.                                                                                                                                   |
| `timeout`, `timeouts`          | Seconds before a built-in step's process tree is killed and the step fails; `timeouts` sets it per step. Unset means unbounded.                                                                                                                                                                                              |
| `failOnSkipped`                | Fail (`reason=skipped-steps`) when a built-in step is skipped because the project has nothing for it. A step in `skip` never fails it.                                                                                                                                                                                       |
| `lintReport`                   | Project-relative path the lint step writes its `--report` JSON to; extra steps receive its absolute path as `FIREFORGE_CHECK_LINT_REPORT`.                                                                                                                                                                                   |
| `extraSteps[].name`            | Lowercase letters, digits and dashes; must not repeat a built-in name.                                                                                                                                                                                                                                                       |
| `extraSteps[].command`         | Run with `/bin/sh -c` (`cmd.exe /c` on Windows) from the project root or `cwd`. Passes on exit 0.                                                                                                                                                                                                                            |
| `extraSteps[].timeout`         | Seconds; past it the whole process tree is killed and the step fails.                                                                                                                                                                                                                                                        |
| `extraSteps[].after`           | Steps (built-in or extra) that must finish first, whatever their outcome. An unknown name or a cycle is refused.                                                                                                                                                                                                             |
| `extraSteps[].footprint`       | What the step needs in a job. `{ "static": true, "cpu": 2, "memory": 2 }` declares no build, browser or Mach, so `check` stays parallel beside other work (`cpu` defaults to 1, `memory` is GiB). Without a static footprint `check` needs a quiet host and the native toolchain ([`jobs-and-slots.md`](jobs-and-slots.md)). |

The verdict line names skipped steps as `skipped-steps=<a,b>` beside
`skipped=<n>`. The step table's `LOAD` column shows the 1-minute load average at a
step's start and end (`12.3→18.0`); it is `-` on Windows.

## `sources`, `slots`, `build.release` and `proof`

| Block                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`                  | Switches the project to source mode: `mode`, `root`, `metadataRoot`, `pristineCommit`, with `test.reapOrphans: "owned"`. See [`authored-sources.md`](authored-sources.md); `authored migrate` writes it.                                                                                                                                                                                                    |
| `slots.dependencyCaches[]` | `{source, target, lockfile?}`: dependency trees slots hold beside captured source. The root `node_modules` needs no entry; `lockfile` defaults to `package-lock.json` beside `target`. `target` is a canonical path; inside `engine/` it can only be a `node_modules`. See [`jobs-and-slots.md`](jobs-and-slots.md).                                                                                        |
| `build.release`            | `{overlay, secrets?: {variable, files}, outputs?}` for `job run --release` (`package --recipe release`). `host init --release-secrets <dir>` names where the secret files live; `outputs` lists paths in the release object directory that the job copies to its output directory. See [`jobs-and-slots.md`](jobs-and-slots.md).                                                                            |
| `proof`                    | `mainBranch`, `consumerLimit`, `noneRoutes` and `gate` (`mode`, lanes, stress, controls, runs, acceptance). A lane takes `holdFront`, `throttle` and `validate`, a run takes `validate`; an acceptance takes `evidence`. A changed `proof`, `check`, `patchLint`, `patchPolicy` or `typecheck` section, or a changed file a gate names as a judge, needs `accept:proof-config`. See [`proof.md`](proof.md). |

Every key in these blocks is validated.

## `exportQueue`

How `authored export-queue` groups the files the project created (and generated
files with no upstream counterpart) into patches. Upstream changes are always one
patch per component.

```json
{
  "exportQueue": {
    "groups": [
      { "name": "ui-tiles", "paths": ["browser/base/content/test/tiles/**"] },
      { "name": "infra-assist", "paths": ["browser/modules/acme/Assist*.sys.mjs"] }
    ],
    "maxGroupBytes": 1048576
  }
}
```

| Key             | What it does                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `groups[]`      | `{name, paths}`: a created file joins the first group one of whose engine-relative globs it matches, as patch `002-<name>.patch`. A name is lowercase words joined by hyphens, and its first word is the patch's category. Names must be unique. |
| `maxGroupBytes` | Budget for created files no group matches (default 1 MiB): a directory becomes one patch, `002-created-<directory>.patch`, once its whole subtree fits; otherwise its own files form that patch and each subdirectory is grouped the same way.   |

A directory with more files of its own than the budget still becomes one patch;
give its files named groups to split it. See
[authored-sources.md](authored-sources.md#exporting-a-patch-queue).

## Design tokens

Tokens are managed with `fireforge token add`; `token list` and `token show` report
what is there; `token lint` checks it.

- `--create-category` declares a category banner and inserts the token in one step.
  It cannot be combined with `--variant`: add the base token first, then each variant.
- `--category` is required for a base declaration and optional under `--variant`,
  where the declaration goes into a `:root<selector>` block; it is validated when given.
- `--variant` takes one attribute fragment (`[data-private]`,
  `[data-skin=precision]`), a run of them, and an optional pseudo-class tail
  (`[data-skin=precision]:not([data-private])`). Names and values must be
  identifier-safe and `=value` is normalized to `="value"`. A variant with a
  qualifier matches only a block carrying it; one without still matches a qualified
  block, and the write says so.
- Variant writes warn when a later declaration of the same token has equal
  specificity in supported root/attribute selectors that can co-match. CSS order is
  left for review; the warning is not a full cascade analysis.
- `--mode override` mirrors into `:root[data-theme="dark"]` and
  `:root[data-theme="light"]`; a qualified block is written through with a warning.
- A token already in the target block is reported with its location and left unchanged.

`fireforge token list [--category <name>] [--json]` reports each category banner
with its tokens in file order. Declarations above the first banner appear under
`(no category)`; a banner with no tokens is still listed; an unknown `--category`
is refused naming the existing ones. `fireforge token show <token-name> [--json]`
reports the owning category and the value and line in every block that declares it
(base `:root`, dark `@media` mirror, each `:root[variant]`). Pass `--` first when
the name starts with `--` (`fireforge token show -- --my-token`).

`fireforge token lint [--json]` exits non-zero on:

- `token-lockstep`: a themed override block declares a token with the project's
  prefix that the base `:root` does not. Non-prefixed overrides (`--moz-*`) are
  ignored.
- `token-undeclared`: a `var(--<prefix>…)` in the tokens CSS or any CSS file the
  project touches names a token no block declares. The project's files are those a
  queue patch touches or, in source mode, every created, overridden and generated
  file of the captured snapshot. Exempt: a property declared in the same file,
  `furnace.json` `tokenAllowlist` and `runtimeVariables`, a `var()` with a fallback,
  and a token a sibling sheet declares. Sheets are siblings when one of the
  project's documents links both (`<link>`, `<html:link>`, `<?xml-stylesheet?>`, in
  markup or a Lit template; a `chrome://` URL resolves through the project's jar.mn
  files), when one `@import`s the other, or when `furnace.json` `tokenSiblingSheets`
  pairs them, e.g. `{ "browser/themes/**/panel*.css": ["browser/base/content/host.css"] }`.

The prefix is `furnace.json` `tokenPrefix`, else `--<binaryName>-`.

## Smoke runs and profiles

`fireforge run --smoke-exit <s> --headless` launches headless and exits after `s`
seconds. A headed smoke window absorbs live input and contaminates the console
capture, so headed non-CI launches warn. Exit 12 is a console regression and 13 a
launch failure ([`exit-codes.md`](exit-codes.md)). A browser that exits cleanly
before the window elapses without printing console output (mach's own log lines
do not count) fails with 13.

A smoke run starts on a fresh temporary profile under the OS temp directory,
seeded with the two prefs `mach run` writes into profiles it makes
(`browser.shell.checkDefaultBrowser`, `browser.aboutConfig.showWarning`). It is
removed when the run ends, including on failure and SIGINT/SIGTERM; after a
SIGKILL the next `run` removes any temporary profile whose owner is gone.

- `--profile <path>` launches with that profile and leaves it. Under `--smoke-exit`
  it replaces the fresh default. Firefox also gets `-purgecaches`, because a
  `build --ui` keeps the build id the startup cache is keyed on;
  `--no-purge-caches` keeps the cache.
- `--temp-profile` gives a plain `run` the same fresh, removed-afterwards profile.
  A plain `run` without either flag keeps mach's `profile-default`.
- Arguments after `--` go to the browser. A headed session on a kept profile that a
  chrome-context Marionette client drives is
  `fireforge run --profile <dir> -- -marionette -remote-allow-system-access`, with
  `marionette.port` set in the profile's `user.js`.
- With an explicit profile, mach neither writes its `runprefs` from
  `~/.mozbuild/machrc` nor accepts `--setpref`.

After a build, mach leaves `.purgecaches` in the app directory. The next launch of
the objdir app purges the startup cache of whichever profile it starts on and
deletes the file; only that first launch purges, so start other reused profiles
with `-purgecaches`. `build --ui` says so in one line.

The console allowlist (`--console-allow-file`) is count-blind by default. A
`# max-hits: N` comment directly above an entry (other comments may sit between)
caps how many lines it may match per run; past it the run fails with exit 12. A
directive with no entry after it is refused.

## Lock waits

Every command that mutates the engine takes the engine-session lock, and some take
a second subsystem lock. Contention fails fast after about a second (exit 15).

`--wait-lock [seconds]` (bare means 60; range 1 to 86400) replaces that with a
bounded wait covering every lock the command takes (for `furnace apply`, `deploy`
and `sync`, the furnace lock too). Furnace leaves that take only the furnace lock
apply it to that lock. A progress line about every 5 seconds names the holder by
PID, command and start time. Waiters are served in arrival order; a crashed or
stopped waiter drops out of the queue. Commands that take no lock accept and ignore
the flag, so a script can append it everywhere (it is hidden from their help).

`FIREFORGE_WAIT_LOCK=<seconds>` applies the same budget to every command in a
session, including the furnace lock of a build's pre-build apply and
`doctor --repair-furnace`; an explicit flag wins. On an engine several sessions
share, set it once. `re-export --dry-run` takes no lock, so a clean preview says
nothing about whether the writing run will get one. `fireforge status --lock`
reports the holder and queue depth.

## Environment variables

| Variable                             | Effect                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FIREFORGE_WAIT_LOCK`                | Session-wide lock wait budget in seconds (1 to 86400).                                                                                     |
| `FIREFORGE_SESSION_ID`               | Recorded as `sessionId` on every patch history record this process writes.                                                                 |
| `FIREFORGE_LOG_KEEP`                 | Also write every `test`/`build` run log here, outside retention (a directory collects one file per run). See [`run-logs.md`](run-logs.md). |
| `FIREFORGE_MAX_UNTRACKED_FILES`      | Per-directory cap when `status` expands collapsed untracked directories (default 5000). A non-positive value warns and is ignored.         |
| `FIREFORGE_GIT_ADD_TIMEOUT_MS`       | Timeout for the monolithic `git add -A` baseline pass (default 10 min).                                                                    |
| `FIREFORGE_GIT_ADD_CHUNK_TIMEOUT_MS` | Timeout for the chunked `git add -- <dir>` fallback (default 30 min).                                                                      |
| `FIREFORGE_COORDINATOR`              | Coordinator namespace directory for jobs and slots (default `~/.fireforge/host/jobs`); `--namespace` overrides it per command.             |
| `FIREFORGE_TOOLCHAINS`               | Where `host init` freezes toolchains (default `~/.fireforge/toolchains`).                                                                  |
| `FIREFORGE_OWNER`                    | Free-text owner label shown in `job list` (default `user@host`). It grants nothing.                                                        |
| `FIREFORGE_PRISTINE_REPOSITORY`      | Pristine object donor for source-mode commands, used before the host's template and the checkout's `engine/`.                              |
| `FIREFORGE_CAPTURED_FILES`           | Set inside a job: path to the list of captured files, for project check steps.                                                             |

`CLAUDECODE` is read by mozbuild, not FireForge; `fireforge test --full-output`
unsets it for test dispatches only ([`testing.md`](testing.md)).
