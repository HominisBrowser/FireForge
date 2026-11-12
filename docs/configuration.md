<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Configuration

A project is configured by `fireforge.json` at its root, and its components by `furnace.json` beside it. Both are checked against a schema on every command: a wrong type or value names the key path, and an unknown key is refused with the nearest known key. Invalid configuration exits 2.

Read and change `fireforge.json` through the schema:

```sh
npx fireforge config get firefox.version
npx fireforge config get gate.lanes[0].files
npx fireforge config set build.jobs 12
npx fireforge config set patchLint.rules '{"jsdoc-class-method": "warning"}'
```

`config set` reads the value as JSON when the key accepts that (`4`, `true`, `["a"]`) and as text otherwise, validates the whole file with the change, and rewrites only the changed value, keeping the rest of the file's layout.

`config set` does not change `mode`, because the mode moves together with the `source` block and the files that hold the owned changes; it fails with the code `config-mode-switch` (exit 8) and names the route. `fireforge migrate` converts a patch-mode project to source mode. Going back is `fireforge export`, then a hand edit that sets `mode` to `patches` and removes `source` ([source-workflow.md](source-workflow.md#coming-from-patch-mode-going-back)).

Paths are project-relative unless the table says engine-relative (a path inside Firefox, such as `browser/base/content/browser.js`). Neither kind may be absolute or climb out with `..`. Globs use `*` within one path segment and `**` across segments.

## Identity and mode

| Key             | Type                                                    | Default                  | Meaning                                                                                         |
| --------------- | ------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `name`          | string                                                  | required                 | Display name of the browser                                                                     |
| `vendor`        | string                                                  | required                 | Vendor or company name                                                                          |
| `appId`         | string                                                  | required                 | Application ID in reverse-domain form, such as `org.mybrowser.browser`                          |
| `binaryName`    | string                                                  | required                 | Executable name: a lowercase letter, then lowercase letters, digits and hyphens                 |
| `license`       | `EUPL-1.2` \| `MPL-2.0` \| `0BSD` \| `GPL-2.0-or-later` | `EUPL-1.2`               | SPDX identifier of the project license; the license header lint expects on created files        |
| `markerComment` | string                                                  | `binaryName` in capitals | Marker appended as a comment to lines FireForge writes into upstream files, such as `MYBROWSER` |
| `mode`          | `patches` \| `source`                                   | `patches`                | Where owned changes live: a patch queue, or tracked files under `source.root`                   |

The identity strings are substituted into the mozconfig templates (`${name}`, `${vendor}`, `${appId}`, `${binaryName}`), so they refuse control characters. `fireforge setup` proposes the same default license and writes `license` explicitly.

## `source`

Present exactly when `mode` is `source` ([source-workflow.md](source-workflow.md)).

| Key                     | Type   | Default  | Meaning                                                                |
| ----------------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `source.root`           | string | required | Directory whose files supply the engine files of the same path (`src`) |
| `source.metadataRoot`   | string | required | Directory holding the override records (`.fireforge-sources`)          |
| `source.pristineCommit` | string | required | Commit the pinned Firefox archive imports as                           |

`root` and `metadataRoot` are canonical relative directories, neither inside the other, and outside `engine`, `.git`, `.fireforge`, `node_modules`, `patches`, `secrets`, `components` and `configs`.

## `firefox`

The pin: which Firefox release the project builds on.

| Key                               | Type                                                                 | Default  | Meaning                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `firefox.version`                 | string                                                               | required | Firefox release, such as `140.9.0esr` or `147.0b1`                                                                            |
| `firefox.product`                 | `firefox` \| `firefox-esr` \| `firefox-beta` \| `firefox-devedition` | required | Product the version belongs to; an `esr` version pairs with `firefox-esr`, a beta with `firefox-beta` or `firefox-devedition` |
| `firefox.sha256`                  | string                                                               |          | Pinned SHA-256 of the source archive; wins over the `SHA256SUMS` Mozilla publishes                                            |
| `firefox.allowUnverifiedDownload` | boolean                                                              | `false`  | Accept a download whose published digest cannot be fetched, trusting TLS alone; ignored with `sha256`                         |
| `firefox.candidate`               | string                                                               |          | Release-candidate build directory, such as `build2`, for pre-release verification                                             |

Change the pin with `fireforge rebase --to <version>`, which also moves the project's changes.

## `build`

| Key                              | Type        | Default  | Meaning                                                                     |
| -------------------------------- | ----------- | -------- | --------------------------------------------------------------------------- |
| `build.jobs`                     | integer ≥ 1 | mach's   | Parallel jobs for `mach build`; `build -j` overrides it                     |
| `build.release.overlay`          | path        | required | Captured mozconfig fragment appended last for a release build               |
| `build.release.secrets.variable` | string      | required | Environment variable the release build receives the secrets directory in    |
| `build.release.secrets.files`    | array       | required | File names that must be in that directory; a release missing one is refused |
| `build.release.outputs`          | array       |          | Paths in the release object directory to collect, such as `dist/*.dmg`      |

`fireforge package --release` builds with `build.release` in an object directory of its own, emptied first, and leaves the development build alone. The secrets directory is set per host as `releaseSecrets` in `~/.fireforge/host.json`; the release build gets it in the environment variable `secrets.variable` names, and a release whose secrets are declared is refused while that directory is unset or lacks one of `secrets.files`.

## `buildAudit`

After a build, FireForge warns about front-end files that changed since the previous build and that nothing packages: such a file builds without complaint and is simply absent from the browser.

| Key                              | Type   | Default  | Meaning                                                    |
| -------------------------------- | ------ | -------- | ---------------------------------------------------------- |
| `buildAudit.unpackaged[].path`   | path   | required | Engine-relative path, exact or with `*` inside one segment |
| `buildAudit.unpackaged[].reason` | string | required | Why the file is never packaged                             |

## `test`

| Key                           | Type              | Default | Meaning                                                                                                                      |
| ----------------------------- | ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `test.mochitestPorts`         | `fixed` \| `auto` | `fixed` | `auto` lets a run proceed while another workspace holds the Marionette port or, where the harness can move, a server port    |
| `test.harnessFailurePatterns` | array             |         | Regular expressions of output lines meaning the browser failed before any test ran; such a run reads `crash`, not `no-tests` |

## `patchLint`

The quality rules over owned changes ([quality.md](quality.md)).

| Key                                    | Type                          | Default   | Meaning                                                                                    |
| -------------------------------------- | ----------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `patchLint.rules`                      | map of rule ID to severity    |           | `off`, `notice`, `warning` or `error` per rule, replacing its default                      |
| `patchLint.waivers`                    | array                         |           | Waivers per group of owned changes, beside those a patch manifest carries                  |
| `patchLint.waivers[].group`            | string                        | required  | The group: a patch or component name such as `ui-sidebar`, or the full group ID            |
| `patchLint.waivers[].rule`             | rule ID                       | required  | The rule waived                                                                            |
| `patchLint.waivers[].max`              | integer ≥ 0                   |           | Largest measurement still waived; without it the rule is waived at any size                |
| `patchLint.waivers[].reason`           | string                        | required  | Why the waiver exists                                                                      |
| `patchLint.waivers[].share`            | `product` \| `test`           |           | Share of the group a `large-patch-lines` ceiling bounds; needs `max`                       |
| `patchLint.checkJs`                    | boolean                       | `false`   | Type-check created modules (`checkjs-type-error`)                                          |
| `patchLint.checkJsStrict`              | boolean                       | `false`   | Run checkJs with `strict` and `noImplicitAny`; needs `checkJs`                             |
| `patchLint.checkJsCompilerOptions`     | object                        |           | Overrides after the strict preset; needs `checkJsStrict` (see below)                       |
| `patchLint.checkJsExtraShim`           | path                          |           | `.d.ts` added to the Firefox globals shim for checkJs                                      |
| `patchLint.checkJsTestFiles`           | boolean                       | `false`   | Also check created test scripts, each as its own program; needs `checkJs`                  |
| `patchLint.checkJsTestShim`            | path                          |           | `.d.ts` of typed harness declarations; needs `checkJsTestFiles`                            |
| `patchLint.litTypes`                   | boolean                       | `false`   | Type Lit in the checkJs shim with closed member lists; needs `checkJs`                     |
| `patchLint.undefinedIdentifiers`       | `off` \| `warning` \| `error` | `warning` | How checkJs reports undefined identifiers                                                  |
| `patchLint.rawColorAllowlist`          | array                         |           | Paths (exact or basename) exempt from `raw-color-value`                                    |
| `patchLint.fileSizeThresholds`         | object                        |           | `file-too-large` bands per file class (`general`, `test`), merged over the defaults        |
| `patchLint.fileSizeMetric`             | `raw` \| `code`               | `raw`     | What `file-too-large` counts: every line, or lines carrying code                           |
| `patchLint.patchSizeThresholds`        | object                        |           | Size bands per tier (`general`, `test`, `branding`), each with `lines` and `files`         |
| `patchLint.patchSizeMetric`            | `diff` \| `addedCode`         | `diff`    | What `large-patch-lines` counts: every diff line, or added lines carrying code             |
| `patchLint.patchSizeRegistrationFiles` | array                         |           | Globs of registration files neither patch-size rule counts                                 |
| `patchLint.tokenScales`                | array                         |           | CSS property families whose values in created stylesheets must be scale tokens (see below) |

**Size bands.** Each band object takes `notice`, `warning` and `error` (integers ≥ 1); what you leave out keeps the default, and the result must stay ordered `notice ≤ warning ≤ error`. The defaults are in [quality.md](quality.md#rules).

```json
{
  "patchLint": {
    "fileSizeThresholds": { "general": { "warning": 800, "error": 1000 } },
    "patchSizeThresholds": {
      "general": { "lines": { "warning": 2000 }, "files": { "warning": 8 } }
    }
  }
}
```

**`checkJsCompilerOptions`** takes the booleans `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `noImplicitThis`, `useUnknownInCatchVariables`, `strictPropertyInitialization`, `noUnusedLocals`, `noUnusedParameters`, and `paths`, a module-resolution mapping with engine-relative targets (each pattern may hold one `*`).

**`tokenScales[]`** entries:

| Key             | Type                      | Meaning                                                                          |
| --------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `properties`    | array, required           | CSS properties governed: exact names or `*`-suffixed prefixes such as `padding*` |
| `prefix`        | string or array, required | Custom-property prefix of the scale tokens, such as `--mybrowser-space-`         |
| `allowLiterals` | array                     | Literal values accepted without a token; `*` is a wildcard                       |
| `allow`         | array                     | Further custom properties accepted: exact names or `*`-suffixed prefixes         |
| `allowInCalc`   | array                     | Literal values accepted only inside `calc()`, `min()`, `max()` or `clamp()`      |
| `offsetCap`     | number ≥ 0                | Largest total px a declaration may subtract from scale tokens in a math function |
| `exclude`       | array                     | Engine-relative globs of files the scale skips                                   |
| `minFiles`      | integer ≥ 1               | Fewest created stylesheets that must declare a governed property                 |
| `allowValues`   | array                     | Reviewed declarations accepted as written: `{ "property", "value", "reason" }`   |

## `patchPolicy`

Which upstream files owned changes may touch, and how the patch queue is ordered ([quality.md](quality.md#policy), [patch-workflow.md](patch-workflow.md#queue-operations-patch)).

| Key                                                    | Type              | Default  | Meaning                                                                                                                                        |
| ------------------------------------------------------ | ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchPolicy.ranges`                                   | array             | required | Order bands owned by categories: `{ "from", "to", "category" }`, inclusive, not overlapping                                                    |
| `patchPolicy.reservedRanges`                           | array             |          | Order bands for listed exceptional patches: `{ "from", "to", "allowed" }`                                                                      |
| `patchPolicy.reservedRanges[].allowed[].filename`      | string            | required | Group ID of the exception: the patch file name allowed in the range, or in source mode the component                                           |
| `patchPolicy.reservedRanges[].allowed[].files`         | array             |          | Exact upstream files the exception may change outside the allowlist; any when absent                                                           |
| `patchPolicy.reservedRanges[].allowed[].adr`           | path              |          | Decision record documenting the exception                                                                                                      |
| `patchPolicy.reservedRanges[].allowed[].documentation` | path              |          | Documentation of the exception                                                                                                                 |
| `patchPolicy.filenamePattern`                          | string            |          | Regular expression with named captures `order`, `category` and `slug` every patch file name must match                                         |
| `patchPolicy.requireDescription`                       | boolean           | `false`  | An empty patch description is a violation                                                                                                      |
| `patchPolicy.allowGaps`                                | boolean           | `true`   | Allow unoccupied orders within a category range                                                                                                |
| `patchPolicy.mutationMode`                             | `error` \| `warn` | `error`  | How queue operations treat a policy problem they would add: `error` refuses it; `warn` reports it and lowers the policy lint rules to warnings |
| `patchPolicy.upstreamAllowlist`                        | array             |          | Globs, or entries `{ "path", "addOnly", "marker", "retiredPaths" }`, naming the upstream files owned changes may modify                        |
| `patchPolicy.addOnlyMarker`                            | string            |          | Marker for `addOnly` entries that set none                                                                                                     |
| `patchPolicy.scopeRules`                               | array             |          | `{ "group", "files" }`: groups whose ID matches the `group` regular expression touch only files matching `files`                               |
| `patchPolicy.verifyDocumentPaths`                      | boolean           | `false`  | Require the `adr` and `documentation` paths of reserved exceptions to exist                                                                    |

## `typecheck`

| Key                              | Type                          | Default   | Meaning                                                                                                     |
| -------------------------------- | ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `typecheck.projects`             | array                         | required  | `jsconfig.json` or `tsconfig.json` files checked whole; a path under `engine/` names the workspace's engine |
| `typecheck.extraShim`            | path                          |           | `.d.ts` added to the Firefox globals shim of every project                                                  |
| `typecheck.projectOverrides`     | map                           |           | Per project (keyed as in `projects`): another `.d.ts` instead of `extraShim`, or `null` for none            |
| `typecheck.undefinedIdentifiers` | `off` \| `warning` \| `error` | `warning` | How undefined identifiers are reported                                                                      |
| `typecheck.litTypes`             | boolean                       | `false`   | Type Lit in the shim with closed member lists                                                               |

## `check`

The composed static check ([quality.md](quality.md#check)).

| Key                          | Type             | Default  | Meaning                                                                               |
| ---------------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------- |
| `check.skip`                 | array            |          | Built-in steps this project never runs                                                |
| `check.status.failOn`        | array            | all      | Status codes that fail the status step                                                |
| `check.status.allow`         | array            |          | Status codes the status step accepts                                                  |
| `check.maxWarnings.lint`     | integer ≥ 0      |          | Warnings the lint step tolerates                                                      |
| `check.maxWarnings.furnace`  | integer ≥ 0      |          | Warnings the furnace-validate step tolerates                                          |
| `check.extraSteps[].name`    | string           | required | Step name: lowercase letters, digits and dashes, not a built-in step's name           |
| `check.extraSteps[].command` | array            | required | Argument vector run from the project root; the step passes on exit 0                  |
| `check.extraSteps[].timeout` | integer ≥ 1      | `600`    | Seconds before the step is killed and fails                                           |
| `check.extraSteps[].engine`  | boolean          | `false`  | The step reads the engine: it runs holding the workspace, with `FIREFORGE_ENGINE` set |
| `check.extraSteps[].after`   | array            |          | Steps that must finish first, whatever their outcome                                  |
| `check.minTokenCoverage`     | integer 0 to 100 |          | Percentage below which the token-coverage step fails                                  |
| `check.failOnSkipped`        | boolean          | `false`  | Fail when a built-in step is skipped for having nothing to run                        |
| `check.lintReport`           | path             |          | File the lint step writes its JSON report to (`FIREFORGE_CHECK_LINT_REPORT`)          |

## `gate`

What `fireforge gate` runs besides `check`. [gate.md](gate.md) explains each entry with an example.

| Key                             | Type                                      | Default  | Meaning                                                                                                                   |
| ------------------------------- | ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `gate.build`                    | `ui` \| `full`                            | `ui`     | The build the gate runs; a workspace that needs a full build gets one either way                                          |
| `gate.documents`                | array                                     |          | Globs of paths that change nothing the gate tests; a pattern without a slash matches a file name at any depth             |
| `gate.lanes[].id`               | string                                    | required | Lane ID: lowercase letters, digits, `.`, `_`, `-`                                                                         |
| `gate.lanes[].files`            | array                                     | required | Engine-relative globs or literal paths of the tests                                                                       |
| `gate.lanes[].exclude`          | array                                     |          | Tests left out of `files`                                                                                                 |
| `gate.lanes[].dispatch`         | `shards` \| `one-browser` \| `standalone` | `shards` | A browser per file, one browser for all, or a restart between files                                                       |
| `gate.lanes[].headed`           | boolean                                   | `false`  | Runs with a visible window, holding the display                                                                           |
| `gate.lanes[].env`              | map                                       |          | Harness environment; a value starting `{artifacts}` names a path in the lane's output directory                           |
| `gate.lanes[].uploadDir`        | boolean                                   | `false`  | Gives the harness a `MOZ_UPLOAD_DIR` in the lane's output directory                                                       |
| `gate.lanes[].machArgs`         | array                                     |          | `--setpref=<name>=<value>` arguments whose value names no path                                                            |
| `gate.lanes[].validate.command` | array                                     | required | Argument vector run after a clean harness exit: `node <script>` or a committed script; `{artifacts}` expands              |
| `gate.stress[]`                 | lane keys, plus `repeat`                  |          | A lane run `repeat` (integer ≥ 1, required) times; every repetition must pass                                             |
| `gate.controls[].id`            | string                                    | required | Control ID                                                                                                                |
| `gate.controls[].diff`          | path                                      | required | Committed diff holding the mutation                                                                                       |
| `gate.controls[].test`          | engine path                               | required | Test that must catch it                                                                                                   |
| `gate.controls[].assertions`    | array                                     | required | Labels of the reds it must produce, every one and no other                                                                |
| `gate.runs[].id`                | string                                    | required | Run ID                                                                                                                    |
| `gate.runs[].smokeExit`         | integer ≥ 1                               | required | Seconds the console is watched before the browser is ended                                                                |
| `gate.runs[].headless`          | boolean                                   | `false`  | Starts without a window                                                                                                   |
| `gate.runs[].args`              | array                                     |          | Arguments for the browser                                                                                                 |
| `gate.runs[].consoleAllowFile`  | path                                      |          | Committed file of console line patterns the smoke start accepts                                                           |
| `gate.runs[].validate.command`  | array                                     | required | As on a lane                                                                                                              |
| `gate.acceptance[].id`          | string                                    | required | Acceptance ID                                                                                                             |
| `gate.acceptance[].reason`      | string                                    | required | What the person decides                                                                                                   |
| `gate.acceptance[].evidence`    | array                                     |          | `lane:<id>`, `stress:<id>`, `control:<id>` or `run:<id>` entries whose outputs the person looks at; each must be declared |

IDs are unique within each list.

## `exportQueue`

How a source-mode `export` groups created files into patches ([source-workflow.md](source-workflow.md#writing-a-patch-queue-export)).

| Key                          | Type        | Default   | Meaning                                                                |
| ---------------------------- | ----------- | --------- | ---------------------------------------------------------------------- |
| `exportQueue.groups[].name`  | string      | required  | The group's ID and patch name: lowercase words joined by hyphens       |
| `exportQueue.groups[].paths` | array       | required  | Engine-relative globs; a created file joins the first group it matches |
| `exportQueue.groups[].tier`  | `branding`  |           | Size tier written into the generated queue for the group's patch       |
| `exportQueue.componentTiers` | map         |           | Size tier (`branding`) per component of upstream changes               |
| `exportQueue.maxGroupBytes`  | integer ≥ 1 | `1048576` | Byte budget of a directory group for created files no group matches    |

## `wire`

| Key                 | Type        | Default                              | Meaning                                                              |
| ------------------- | ----------- | ------------------------------------ | -------------------------------------------------------------------- |
| `wire.subscriptDir` | engine path | `browser/base/content`               | Directory of wired chrome subscripts                                 |
| `wire.domTarget`    | engine path | `browser/base/content/browser.xhtml` | Top-level chrome document that wired DOM fragments are included into |

## `externalToolchains`

Tools the project needs beyond what Firefox's own build needs, in named groups. `fireforge doctor` looks for each tool and reports one row per tool, naming the toolchain and the tool.

| Key                                     | Type    | Default  | Meaning                                                                               |
| --------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------- |
| `externalToolchains[].name`             | string  | required | Toolchain name, such as `seasonal-branding`                                           |
| `externalToolchains[].tools`            | array   | required | The tools it needs, at least one                                                      |
| `externalToolchains[].tools[].name`     | string  | required | Tool name, and what is looked up when no `path` is set                                |
| `externalToolchains[].tools[].path`     | string  |          | Executable path, absolute or project-relative; the tool is found when the path exists |
| `externalToolchains[].tools[].xcrun`    | boolean |          | Find the tool with `xcrun -find <name>` instead of on `PATH`                          |
| `externalToolchains[].tools[].required` | boolean | `true`   | A missing tool fails `doctor`; with `false` it is a warning                           |

A tool is looked for in one place: at `path` when set, else through `xcrun` when `xcrun` is true, else on `PATH`.

```json
{
  "externalToolchains": [
    {
      "name": "seasonal-branding",
      "tools": [
        { "name": "actool", "xcrun": true },
        { "name": "pngquant", "required": false }
      ]
    }
  ]
}
```

## `furnace.json`

The component configuration ([furnace.md](furnace.md)). It is created with `version` and `componentPrefix` the first time a Furnace command writes it; edits rewrite only the changed values.

| Key                    | Type          | Default                                         | Meaning                                                                                                         |
| ---------------------- | ------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `version`              | `1`           | `1`                                             | Format version                                                                                                  |
| `componentPrefix`      | string        | required                                        | Prefix every custom component name starts with (`moz-` when Furnace creates the file)                           |
| `stock`                | array         | `[]`                                            | Stock components the project composes                                                                           |
| `overrides`            | map           | `{}`                                            | Overrides of stock components, by tag (see below)                                                               |
| `custom`               | map           | `{}`                                            | Custom components, by tag (see below)                                                                           |
| `ftlBasePath`          | path          | `toolkit/locales/en-US/toolkit/global`          | Engine directory localized components deploy their `.ftl` into                                                  |
| `typecheckJsconfig`    | path or array |                                                 | `jsconfig.json` files whose chrome-module `paths` Furnace maintains                                             |
| `typecheckTagMap`      | path          |                                                 | `.d.ts` file Furnace writes with the `HTMLElementTagNameMap` entries                                            |
| `validationExceptions` | array         |                                                 | Reviewed validation warnings: `{ "component", "check", "reason", "tag"?, "file"? }` (a tag or a file, not both) |
| `minComponents`        | integer ≥ 1   |                                                 | Fewest components a full validation judges                                                                      |
| `optInChecks`          | array         |                                                 | Checks that run only when listed: `icon-button-label`                                                           |
| `tokenFile`            | path          | `browser/themes/shared/<binaryName>-tokens.css` | Engine path of the design-token file                                                                            |
| `tokenPrefix`          | string        | `--<binaryName>-`                               | Custom-property prefix of the project tokens                                                                    |
| `tokenAllowlist`       | array         |                                                 | Custom properties from elsewhere that stylesheets may reference                                                 |
| `platformPrefixes`     | array         | `["--moz-"]`                                    | Prefixes of platform-owned custom properties                                                                    |
| `runtimeVariables`     | array         |                                                 | Runtime state channels set from script, accepted as references                                                  |
| `tokenHostDocuments`   | array         |                                                 | Documents that load the token file                                                                              |
| `tokenSiblingSheets`   | map           |                                                 | Sheet glob to the sheets that load beside it                                                                    |

A `custom.<tag>` entry:

| Key               | Type                   | Meaning                                                                                  |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `description`     | string, required       | What the component is                                                                    |
| `targetPath`      | path, required         | Engine directory the component deploys into                                              |
| `register`        | boolean, required      | List the element in `customElements.js`                                                  |
| `localized`       | boolean, required      | The component uses Fluent strings                                                        |
| `kind`            | `element` \| `library` | `library`: base classes and helpers with no element of its own (needs `register: false`) |
| `composes`        | array                  | Components it renders in its template; known names, without cycles                       |
| `keyboardCovered` | boolean                | Keyboard activation comes from a wrapped native element                                  |
| `sharedFtl`       | string                 | An existing feature Fluent file the component shares; needs `localized`                  |

An `overrides.<tag>` entry:

| Key           | Type                 | Meaning                                       |
| ------------- | -------------------- | --------------------------------------------- |
| `type`        | `css-only` \| `full` | `css-only` deploys only stylesheets           |
| `description` | string               | Why it is overridden                          |
| `basePath`    | path                 | Engine directory the stock component lives in |
| `baseVersion` | string               | Firefox version the override was taken from   |
| `baseCommit`  | string               | Commit it was taken from                      |

A name may appear once across `stock`, `overrides` and `custom`.

## Host configuration

`~/.fireforge/host.json` (under `$FIREFORGE_HOME` when set) configures the host, not a project ([workspaces.md](workspaces.md#host-locks)):

| Key              | Type        | Default | Meaning                                                         |
| ---------------- | ----------- | ------- | --------------------------------------------------------------- |
| `buildSlots`     | integer ≥ 1 | `1`     | How many compiles may run at once on this host                  |
| `releaseSecrets` | string      |         | Absolute directory holding the secret files release builds read |

## Environment variables

| Variable              | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `FIREFORGE_HOME`      | Where host state lives instead of `~/.fireforge`                                                          |
| `FIREFORGE_WAIT_LOCK` | Default for `--wait-lock <seconds>`: how long a command waits for a lock or workspace (default two hours) |

FireForge sets `FIREFORGE_PROJECT_ROOT`, `FIREFORGE_OWNED_PATHS`, `FIREFORGE_CHECK_LINT_REPORT` and `FIREFORGE_ENGINE` for `check.extraSteps` ([quality.md](quality.md#extra-steps)). Gate validators get `FIREFORGE_PROJECT_ROOT` and `FIREFORGE_ENGINE` ([gate.md](gate.md#lanes)). Other `FIREFORGE_*` names are reserved for its own processes.
