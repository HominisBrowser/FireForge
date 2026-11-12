<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Quality: lint, policy, typecheck and check

Every quality rule is defined over the **owned changes**: the paths the project adds, modifies or deletes relative to the pinned Firefox. Patch mode and source mode produce the same owned changes from different storage, so the rules mean the same in both. The owned changes come in **groups**: in patch mode a group is a patch; in source mode a group is a component of upstream changes, a group of created files, or the files one Furnace component deploys. Each has an ID, which `fireforge status --groups` lists ([source-workflow.md](source-workflow.md#groups)).

## `lint`

```sh
npx fireforge lint
npx fireforge lint browser/base/content/mybrowser
npx fireforge lint --max-warnings 0
npx fireforge lint --per-patch
```

`lint` runs every rule over the owned changes, applies the waivers, and prints one report. Findings have a severity: `error` fails the run, `warning` fails it only past `--max-warnings`, `notice` never fails it.

- Paths limit which files' findings are reported. Findings about a whole group (size, policy) are always reported.
- `--per-patch` (patch mode) judges the stored queue patch by patch instead of what `engine/` holds. CI should use it: it sees exactly what is committed.
- `lint` takes no workspace. In source mode it reads `src/` and the pristine repository.

### Rules

`patchLint.rules` sets the severity of any rule (`off`, `notice`, `warning`, `error`), replacing its default. A rule whose default is `off` runs only when given a severity there.

```json
{ "patchLint": { "rules": { "jsdoc-class-method": "warning", "observer-topic-naming": "off" } } }
```

| Rule                           | Default | Meaning                                                                                                                |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `missing-license-header`       | error   | Files the project creates start with the project license header                                                        |
| `modified-file-missing-header` | warning | Upstream files the project modifies still start with a recognised license header                                       |
| `relative-import`              | error   | Owned JavaScript imports through `resource://` or `chrome://` URLs, not relative paths                                 |
| `missing-modification-comment` | warning | An edit to upstream JavaScript carries the `// MARKER:` comment (`markerComment`, default the binary name in capitals) |
| `jsdoc`                        | error   | Exports of created modules (`.sys.mjs`) carry JSDoc naming their parameters and return                                 |
| `jsdoc-class-method`           | off     | Methods of exported classes of created modules carry JSDoc                                                             |
| `chrome-script-jsdoc`          | off     | Top-level functions and classes of created chrome scripts carry JSDoc                                                  |
| `test-needs-assertion`         | off     | Every owned or modified browser test makes at least one assertion                                                      |
| `observer-topic-naming`        | warning | Observer topics carrying the binary name follow `<name>-<noun>-<verb>`                                                 |
| `raw-color-value`              | error   | Owned stylesheet lines use custom properties instead of raw colours (`rawColorAllowlist` exempts files)                |
| `token-prefix-violation`       | error   | Custom properties an owned stylesheet references are design tokens                                                     |
| `token-scale`                  | error   | Properties a `tokenScales` entry governs, in created stylesheets, resolve to its scale tokens                          |
| `token-scale-vacuous`          | error   | A scale with `minFiles` governs at least that many created stylesheets                                                 |
| `stale-token-scale-exclude`    | warning | Every token-scale `exclude` names an owned path                                                                        |
| `file-too-large`               | by band | Created JavaScript files stay under the size bands of their class (`fileSizeThresholds`)                               |
| `large-patch-lines`            | by band | A patch's or component's own lines stay under the size bands of its tier (`patchSizeThresholds`)                       |
| `large-patch-files`            | by band | A patch's or component's file count stays under the bands of its tier                                                  |
| `mozbuild-unsorted-list`       | error   | Strict-ordered `moz.build` lists in owned files are sorted, as configure requires                                      |
| `unregistered-system-module`   | error   | A created module that owned code imports by resource URL is installed by a `moz.build` list                            |
| `dangling-registration`        | error   | Manifest entries the owned changes add name files that exist                                                           |
| `forward-import`               | error   | Patch mode: no import names a module only a later patch creates                                                        |
| `forward-registration`         | error   | Patch mode: no manifest entry names a file only a later patch creates                                                  |
| `staged-dependency-unused`     | warning | Every declared staged dependency matches a forward reference                                                           |
| `checkjs-type-error`           | error   | With `checkJs`, created modules (and with `checkJsTestFiles`, test scripts) type-check                                 |
| `upstream-allowlist`           | error   | Upstream files change only where `patchPolicy` allows it                                                               |
| `add-only`                     | error   | Add-only upstream files only gain lines carrying the marker                                                            |
| `scope`                        | error   | Groups a scope rule selects touch only the files it names                                                              |
| `policy-document-missing`      | error   | With `verifyDocumentPaths`, the decision records and documents of reviewed exceptions exist                            |
| `lint-ignore-removable`        | notice  | A waiver ceiling is not needed: the rule reports nothing at warning or error on its group                              |

The size rules report the band a measurement falls in: notice, warning or error. A severity in `patchLint.rules` replaces the band. The default bands:

| Rule                | Class or tier | Notice | Warning | Error |
| ------------------- | ------------- | -----: | ------: | ----: |
| `file-too-large`    | general       |    500 |     750 |   900 |
| `file-too-large`    | test          |   1200 |    1400 |  1600 |
| `large-patch-lines` | general       |    800 |    1500 |  3000 |
| `large-patch-lines` | test          |   1500 |    3000 |  6000 |
| `large-patch-lines` | branding      |   8000 |   18000 | 30000 |
| `large-patch-files` | general, test |        |       5 |       |
| `large-patch-files` | branding      |        |      60 |       |

The two patch-size rules judge patches in patch mode and components (upstream changes) in source mode. A source-mode group of created files, and the files of a Furnace component, are not sized as a group: each file answers to `file-too-large`.

`fileSizeMetric` (`raw` or `code`) and `patchSizeMetric` (`diff` or `addedCode`) choose what is counted, and `patchSizeRegistrationFiles` lists registration files neither patch-size rule counts. A group is in the `test` tier when it changes only tests, and in `branding` when its `tier` says so.

The `policy` rules take `error` from `patchPolicy`, or `warning` under `patchPolicy.mutationMode: "warn"`. [configuration.md](configuration.md) lists every `patchLint` key.

### Waivers

A waiver suppresses one rule's findings on one group. There are two forms:

- A bare rule ID waives the rule at any size.
- A ceiling `{ "rule", "max", "reason", "share"? }` waives a measured finding only while the measurement stays at or below `max`, so growth past the reviewed size surfaces again. A finding without a measurement is not waived. `share` (`product` or `test`) bounds that share of a `large-patch-lines` count. When a ceiling suppresses nothing at warning or error, `lint-ignore-removable` says so.

Where they live:

- **Patch mode**: in the patch's `lintIgnore` in `patches/patches.json`, edited with `patch set`:

  ```sh
  npx fireforge patch set ui-sidebar --lint-ignore file-too-large --reason "Generated table"
  npx fireforge patch set ui-sidebar --lint-ignore large-patch-lines --max 1800 --reason "Reviewed: one feature"
  npx fireforge patch set ui-sidebar --remove-lint-ignore file-too-large
  ```

- **Either mode**: in `patchLint.waivers` in `fireforge.json`:

  ```json
  {
    "patchLint": {
      "waivers": [
        {
          "group": "ui-sidebar",
          "rule": "large-patch-lines",
          "max": 1800,
          "reason": "Reviewed: one feature"
        }
      ]
    }
  }
  ```

  `group` names the group. In patch mode that is the patch's name (`ui-sidebar`) or its file name (`012-ui-sidebar.patch`). In source mode it is the group's ID exactly as `fireforge status --groups` lists it: the component, the `exportQueue` group, `created-<directory>`, or the Furnace component. In source mode this is the only place for waivers; `migrate --to-source` moves each patch's `lintIgnore` here, and `export` writes them into the generated manifest.

A finding is judged against the group it is attributed to and every group that changes its path.

## Policy

`patchPolicy` says which upstream files owned changes may touch and how. The `lint` rules `upstream-allowlist`, `add-only`, `scope` and `policy-document-missing` enforce it in both modes. The ordering half (`ranges`, `filenamePattern`, `requireDescription`, `allowGaps`) governs the patch queue and is described in [patch-workflow.md](patch-workflow.md#queue-operations-patch).

```json
{
  "patchPolicy": {
    "ranges": [
      { "from": 1, "to": 99, "category": "branding" },
      { "from": 100, "to": 499, "category": "ui" }
    ],
    "upstreamAllowlist": [
      "browser/base/content/browser.js",
      { "path": "browser/base/jar.mn", "addOnly": true },
      "browser/themes/shared/**"
    ],
    "addOnlyMarker": "MYBROWSER",
    "scopeRules": [{ "group": "-branding-", "files": ["browser/branding/**"] }]
  }
}
```

- A path is upstream when its first owned change is not a creation. Every group may change an upstream file only when an `upstreamAllowlist` glob matches it.
- Under an `addOnly` entry a group may only add lines, each carrying the marker (`marker`, or `addOnlyMarker`), and remove lines that name one of the entry's `retiredPaths`.
- A group named by a `reservedRanges[].allowed` entry is an exception: it may change the upstream files the entry's `files` lists (any, when it lists none) outside the allowlist, and its list must not name a file it does not change. With `verifyDocumentPaths`, its `adr` and `documentation` paths must exist.
- `scopeRules[].group` is a regular expression over group IDs. Every file a selected group touches must match one of `files`. Patch-mode group IDs are patch file names (`012-ui-sidebar.patch`); source-mode group IDs are the names `fireforge status --groups` lists, used as they are (`ui-sidebar` for component `ui-sidebar`). A `reservedRanges[].allowed[].filename` names a group by the same ID.

## `typecheck`

```sh
npx fireforge typecheck
npx fireforge typecheck --project engine/browser/components/mybrowser/jsconfig.json
npx fireforge typecheck --explain browser/base/content/mybrowser/panel.mjs
```

`typecheck` runs two passes as one result, green only when both are:

1. Each `typecheck.projects` file (a `jsconfig.json` or `tsconfig.json`, project-relative) is checked whole, with its own compiler options plus the Firefox-globals shim: Firefox's privileged globals, Lit, and the test harness. A path under `engine/` names the file in the workspace's engine, so one configuration serves patch mode and source mode. `extraShim` adds a `.d.ts` to every project's shim, and `projectOverrides` gives one project another `.d.ts` or `null` for none.
2. The owned files get lint's strict `checkJs` pass (when `patchLint.checkJs` is on).

`--project <path>` checks other projects instead of `typecheck.projects`; repeat it for several. `--explain <file>` checks nothing and prints how both passes see the file: which programs include it, with which options and shim.

The typing files Furnace generates must be current; `typecheck` refuses until `fireforge furnace types` has written them. Results are cached by the digest of every file a program read, so an unchanged program is not checked again.

## `check`

```sh
npx fireforge check
npx fireforge check --only lint --only typecheck
npx fireforge check --skip furnace-validate
```

`check` runs the static checks as one judgement and ends with one verdict line ([machine-output.md](machine-output.md#check)):

| Step               | Runs                                                     | Skipped when                        |
| ------------------ | -------------------------------------------------------- | ----------------------------------- |
| `status`           | `fireforge status`                                       |                                     |
| `verify`           | `fireforge verify`                                       |                                     |
| `lint`             | `fireforge lint`                                         |                                     |
| `typecheck`        | `fireforge typecheck`, after `lint` (they share a cache) | `fireforge.json` has no `typecheck` |
| `furnace-validate` | `fireforge furnace validate`                             | the project has no `furnace.json`   |
| `token-coverage`   | `fireforge token coverage`                               | the project has no token file       |
| `token-lint`       | `fireforge token lint`                                   | the project has no token file       |

Steps run side by side unless one is ordered after another. The steps that need an engine (typecheck, component validation, extra steps declaring `engine`) share one workspace, leased when the first of them starts. A step with nothing to run is reported as skipped; `check.failOnSkipped` makes that a failure.

`--only <step>` runs only the named steps and `--skip <step>` leaves steps out; both repeat. `check.skip` leaves built-in steps out for good.

Per-step policy lives in the `check` section:

- `status.failOn`: the status codes that fail the status step (every code when unset); `status.allow`: codes it accepts.
- `maxWarnings.lint` and `maxWarnings.furnace`: the warning ceilings of those steps.
- `minTokenCoverage`: the percentage below which `token-coverage` fails.
- `lintReport`: a project-relative path the lint step writes its JSON report to.

### Extra steps

`check.extraSteps` adds your own commands:

```json
{
  "check": {
    "extraSteps": [
      { "name": "eslint", "command": ["npx", "eslint", "src/"], "timeout": 300 },
      {
        "name": "policy-audit",
        "command": ["node", "scripts/policy-audit.mjs"],
        "after": ["lint"],
        "engine": true
      }
    ]
  }
}
```

- `command` is an argument vector, run from the project root without a shell. The step passes on exit 0.
- `timeout` (seconds, default 600) kills and fails a step that runs longer.
- `after` names steps that must finish first, whatever their outcome.
- `engine: true` runs the step holding the check's workspace.

An extra step's environment carries `FIREFORGE_PROJECT_ROOT`, `FIREFORGE_OWNED_PATHS` (a file listing the owned engine paths, one per line), `FIREFORGE_CHECK_LINT_REPORT` when `check.lintReport` is set (order the step `after: ["lint"]` to read it), and `FIREFORGE_ENGINE`, the engine directory, for a step with `engine: true`.

`check` exits 0 when every step that ran passed, 1 when a step failed, 8 for an unknown step name, and 15 when the workspace did not come free ([exit-codes.md](exit-codes.md#check)).
