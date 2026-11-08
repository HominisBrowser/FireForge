<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Furnace components

Furnace handles UI components: it tracks stock widgets, creates fork-owned
widgets and overrides existing ones. The files land inside the Firefox source
directory and end up in the patches you export.

```bash
npx fireforge furnace scan
npx fireforge furnace override moz-button -t css-only
npx fireforge furnace create moz-my-widget
npx fireforge furnace deploy
npx fireforge furnace status
npx fireforge furnace preview
```

`fireforge furnace --help` lists every subcommand.

## Shared CSS fragments

Put CSS used by more than one widget in `components/shared/` and reference it from
a widget stylesheet:

```css
/* @fireforge-include base-button.css */
```

`deploy` expands the fragment into the deployed copy only, so editing a fragment
shows as component drift until the next deploy. `furnace diff` compares the
deployed copy against the composed form, so a freshly deployed includer shows no
difference.

## Deploying and applying

`furnace deploy` takes any number of names and deploys them under one lock hold
(`fireforge furnace deploy moz-a moz-b`). Each name is its own atomic unit with a
rollback journal: a failing unit restores its own files, and a failure or signal in
a later unit never reverts one already committed. An unknown name refuses the whole
invocation before anything is written; a stock name is warned about and skipped.
With no name, everything deploys.

Deploy copies a component's whole folder and registers every `.mjs` and `.css` file
of a custom component in `toolkit/content/jar.mn`. Add the file to the directory and
deploy rather than writing the jar line by hand. A line that already registers the
file (same target, or same `(widgets/<tag>/<file>)` source) is kept, never
duplicated; removing a file drops only its line.

Summaries name why each component was skipped (`Applied 0, skipped 1 (1 already
current)`). "Already current" means the source is unchanged since the last recorded
apply and the engine copy still matches. The apply state is shared by every session
on the checkout, so that apply may have been a peer's.

`test --build` prints a "dispatch state" notice naming why each deployed component
was behind: source changed since its last deploy, no recorded deploy, or an engine
copy missing or different. A component behind for a reason you did not cause is
another session's edit and is in the build under test. `--furnace-apply all`
(default) deploys every such component; `reached` deploys a stale component only if a
reached custom component `composes` it, or one whose engine copy was erased; `none`
deploys nothing. None removes a copy a peer already deployed.

A deploy, apply or build refuses only when a component _it applied_ had its source
edited while being copied; a peer's edit to another component is reported by name.

When deploy replaces a file whose engine bytes differ from the source and a patch
owns it, it warns naming the file and patch. On a shared checkout where sessions
edit different files of one folder for different patches, name the patch being
exported: `fireforge furnace deploy moz-tiles --owner 205`. A file owned by a
different patch then refuses the whole deploy before any write, listing each file
with its owners; park the other work or export that patch first. A file the named
patch shares with another stays its to deploy, an unknown patch refuses, and
`--dry-run` refuses the same way.

`build` and `test` rewrite deployed component files from their sources first.
`--refuse-unexported-drift` refuses when that would destroy engine content no patch
records. A deployed file that is a Furnace deployment of its own source
(`deployed-unexported`: it equals the composed source, differs only inside fragment
expansions, or is exactly what the last apply deployed) is allowed and listed, since
its patch still owes a re-export.

## Renaming

`furnace rename <old> <new>` moves the component and rewrites its registrations in
place. The `customElements.js` entry keeps its position, layout and
`// <MARKER>:` comments (`markerComment` from `fireforge.json`, else the upper-cased
`binaryName`); an entry is added fresh, with the marker, only when none existed, and
the old entry never survives. The locale `jar.mn` line is re-pointed only when the
old component had one. Package and locale entries are maintained for
`register: false` libraries too. Rename refuses nested directories, symlinks and
special entries before mutation and never removes a destination a competing command
created. `--dry-run` prints every move and engine edit.

## Typed cross-module imports

Set `furnace.json#typecheckJsconfig` to a consumer-owned jsconfig, or a list of
them, and `furnace types`, `deploy` and `sync` maintain `compilerOptions.paths` entries in each,
mapping every deployed `chrome://global/content/elements/<file>.mjs` URL to its
workspace source. List every project whose files import widget modules. An entry
inside the components workspace counts as Furnace-managed: a hand-written entry is
preserved, and a managed entry whose helper was deleted is pruned. Every path in
`furnace.json` (`typecheckJsconfig`, `typecheckTagMap`, `ftlBasePath`, `scanPaths`,
an override's `basePath`, a custom component's `targetPath`) must be relative and
free of `..`.

`furnace.json#typecheckTagMap: "<path>.d.ts"` has the same commands also write a
declaration adding each custom component's tag to `HTMLElementTagNameMap`, typed
`HTMLElement & import(...)` of the component class:

```ts
interface HTMLElementTagNameMap {
  'moz-dock-button': HTMLElement &
    import('chrome://global/content/elements/moz-dock-button.mjs').MozDockButton;
}
```

`createElement` and `querySelector` then type as the class. A component gets an
entry per `customElements.define("<tag>", <Class>)` in its `.mjs` files whose class
the module exports (by name or as `default`); `kind: "library"` or
`register: false` components, unexported or inline classes and customized built-ins
get none. Include the file only in a project listed in `typecheckJsconfig`;
elsewhere the URL falls to the shim's memberless `chrome:*` wildcard. Furnace
rewrites the whole file: do not edit it.

`fireforge furnace types` writes both files and nothing else; `--check` writes
nothing and fails while either is out of date. `validate` reports a stale tag map as
`tag-map-drift` and stale managed jsconfig entries as `jsconfig-paths-drift`. In a
patch-queue project both are warnings, and `fireforge typecheck` regenerates the
files itself before it runs. In source mode the committed copies are what a slot
gets, so both are errors, `typecheck` in a job leaves the files as they are, and a
configured `engine/<path>` names the tracked `<sources.root>/<path>` (see
[authored-sources.md](authored-sources.md#furnace-and-writers)).

## Validation as a gate

`furnace validate` prints findings for people; a gate reads `furnace validate --json`
(one document with the verdict, counts, per-component counts and every finding; see
[`machine-output.md`](machine-output.md)). Errors fail the run. `--max-warnings <n>`
also fails it when more than `n` warnings remain.

Record a reviewed finding in `furnace.json`, not in a gate script:

```json
{
  "validationExceptions": [
    {
      "component": "moz-dock-button",
      "check": "no-keyboard-handler",
      "reason": "Activation goes through the inner moz-button."
    }
  ]
}
```

| Field       | Effect                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `component` | Required. The component the entry applies to.                                                                                          |
| `check`     | Required. The name `validate` prints in brackets.                                                                                      |
| `reason`    | Required, non-empty: the review record.                                                                                                |
| `tag`       | Optional. Narrows to findings about one element tag; a finding naming several tags is suppressed only when entries cover them all.     |
| `file`      | Optional. Narrows to one module of the component (`hardcoded-text` names the modules it found text in). A `tag` or a `file`, not both. |

A matching entry suppresses the finding, which is still listed with its reason under
`excepted` and counted. An entry matching nothing is stale and reported as a
`stale-validation-exception` warning; a run over one component judges only that
component's entries. An entry never suppresses an error: the error stays counted and
the entry is reported as `validation-exception-on-error` until the finding is fixed
and the entry deleted.

Accessibility checks judge the composed component: the host `<tag>.mjs` and its
companion modules (`<tag>-*.mjs`, tests and stories excluded) read as one source, so
moving a template between modules does not change findings. `hardcoded-text` judges
each module alone, so a `// furnace-ignore: hardcoded-text` comment covers its own
file. Toolkit's `panel-item` counts as natively keyboard-activated, beside `button`,
form controls and the `moz-*` buttons.

`minComponents` (`{ "minComponents": 40 }`) is the fewest components a full
`furnace validate` must judge; a run under it, an empty tree included, fails with a
`component-floor` error. A run naming one component is not held to it. Override CSS
inherits token exemptions only from its pinned upstream CSS, never its deployed copy.

`optInChecks` enables checks that are off by default; `["icon-button-label"]` warns
about an icon-only `<moz-button>` in a Lit template (an `iconsrc` or icon type, no
`label` or text) with neither `data-l10n-id` nor `aria-label`. A button built with
`document.createElement` is not seen.

## Safety

Every furnace mutation takes a per-root lock and a rollback journal, restored on a
signal and on a thrown error. An incomplete rollback leaves a `pendingRepair` marker
that blocks further mutations. `create`, `override`, `scan`, `remove`, `rename`,
`refresh` and `chrome-doc` also keep `.fireforge/furnace-inflight.json` while they
run: a process killed outright (SIGKILL, out of memory, power loss) cannot roll back,
and the next furnace mutation or `doctor` turns the sidecar into a `pendingRepair`
marker naming it. `apply`, `deploy` and `preview` are idempotent and need no sidecar.
Clear the marker with `fireforge doctor --repair-furnace`.

`validate --fix` repairs registrations under the same lock and journals its writes;
a writer failure rolls them back. Browser wiring uses attributed journals, so a
peer's later edit is preserved and reported for repair rather than overwritten.

`apply`, `deploy` and `sync` accept `--wait-lock [seconds]` covering both locks they
take; the leaves that take only the furnace lock apply it to that lock. Without the
flag, `FIREFORGE_WAIT_LOCK` applies ([`configuration.md`](configuration.md#lock-waits)).

Chrome-document creation refuses collisions for every planned source and test output,
including after a competing command finished while it waited. Removal matches jar
lines across CRLF and trailing whitespace and keeps other lines. Generated packaging
tests cover the supported unpacked layouts; packed `omni.ja` builds are not probed.
