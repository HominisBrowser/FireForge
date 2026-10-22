<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Furnace components

Furnace is how FireForge handles UI components. It tracks stock widgets,
creates new fork-owned widgets, and overrides existing ones. The files still
land inside the Firefox source directory and end up in the regular patches
you export.

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

CSS used by more than one widget can live in a single file. Put the fragment
in `components/shared/` and reference it from a widget stylesheet with a
comment:

```css
/* @fireforge-include base-button.css */
```

`deploy` expands the fragment into the deployed copy only, so editing the
fragment shows up as component drift until the next deploy. `furnace diff`
compares the deployed copy against this composed form (and says so in the
`+++` header), so a freshly deployed includer shows no difference.

## Deploying and applying

`furnace deploy` takes any number of names and deploys them under one lock
hold (`fireforge furnace deploy moz-a moz-b moz-c`), so a batch of widgets
waits for the engine lock once rather than once per widget. Each name is its
own atomic unit: it is applied and its state persisted before the next starts.
An unknown name refuses the whole invocation before anything is written, and
a stock name is warned about and skipped. With no name, everything deploys.

Deploy registers every `.mjs` and `.css` file in a custom component directory
in `toolkit/content/jar.mn`, including extra modules beside the main one. Add
the file to the directory and deploy instead of writing the jar line by hand.
A line that already registers the file anywhere in the jar (same target, or
same `(widgets/<tag>/<file>)` source) is kept and never duplicated, so mach
does not fail with "Item already in manifest". Removing a file from the
directory drops only its line, and `furnace rename` rewrites the widget's
lines where they stand, so the rest of the block keeps its order and the
owning patch carries no reorder hunks.

The apply and deploy summaries name why each component was skipped, for
example `Applied 0, skipped 1 (1 already current)`. "Already current" means
the source is unchanged since the last recorded apply and the engine copy
still matches it. The apply state is shared by every session on the checkout,
so that apply may have been another session's, such as a peer's
`test --build`.

## Renaming

`furnace rename <old> <new>` moves the component and rewrites its
registrations in place. The `customElements.js` entry keeps its position,
layout and `// <MARKER>:` comments (the marker is `markerComment` from
`fireforge.json`, else the upper-cased `binaryName`); an entry is only added
fresh, with the marker, when none existed. The old entry never survives the
rename. The locale `jar.mn` line is re-pointed only when the old component had
one, so a `sharedFtl` component never gains a per-component `.ftl` line.
`--dry-run` prints every file move and engine edit without writing.

## Typed cross-module imports

For multi-file components, set `furnace.json#typecheckJsconfig` to a
consumer-owned jsconfig. `deploy` then maintains `compilerOptions.paths`
entries that map each deployed
`chrome://global/content/elements/<file>.mjs` URL to its workspace source.

An entry counts as Furnace-managed if it is contained in the components
workspace. A hand-written entry is therefore preserved, and a managed entry
whose helper was deleted is pruned.

## Validation as a gate

`furnace validate` prints its findings for people. A gate reads
`furnace validate --json` instead: one document with the verdict
(`passed`), the counts, per-component counts and every finding, specified in
[`machine-output.md`](machine-output.md). Errors fail the run.
`--max-warnings <n>` also fails it when more than `n` warnings remain, so
`--max-warnings 0` keeps a component tree warning-clean.

A finding that was reviewed and accepted is recorded in `furnace.json`
rather than in a gate script:

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

An entry suppresses every finding of `check` (the name `validate` prints in
brackets) on `component`. Each field is required and the reason must be
non-empty, because the entry is the review record. Suppressed findings are
still listed, with their reason, under `excepted` in the JSON document and
counted in the summary. An entry that matches nothing is stale: the finding
it records is gone, so `validate` reports a `stale-validation-exception`
warning asking for the entry to be deleted. A run over one component judges
only that component's entries. `deploy` honours the same entries when it
validates, but leaves the staleness report to `validate`.

An entry never suppresses an error: an error blocks apply,
and a review record cannot make a broken component deployable. The error
stays counted, and the entry is reported as a
`validation-exception-on-error` error until the finding is fixed and the
entry deleted.

An optional `tag` narrows an entry to findings about one element tag, so a
reviewed `<panel-list>` menu does not mute `no-keyboard-handler` for the
rest of the component. A finding that names several tags (`no-keyboard-handler`
names every synthetic element with an `@click`) is suppressed only when
entries cover all of them:

```json
{
  "component": "moz-vault",
  "check": "no-keyboard-handler",
  "tag": "li",
  "reason": "Rows are reached through the list's roving focus."
}
```

An optional `file` narrows an entry the same way to findings
in one module of the component, by file name. `hardcoded-text` names the
modules it found text in, so a vendored bundle whose bytes are pinned (and
so cannot carry a `furnace-ignore` comment) can be accepted while the
authored modules beside it keep the check. An entry names a `tag` or a
`file`, not both:

```json
{
  "component": "moz-editor",
  "check": "hardcoded-text",
  "file": "moz-editor-codemirror.mjs",
  "reason": "The vendored bundle's width probe is never rendered."
}
```

Accessibility checks judge the composed component: the host
`<tag>.mjs` and its companion modules (`<tag>-*.mjs`, tests and stories
left out) read as one source. Moving a template between the component's
modules therefore does not change its findings: a keyboard handler in a
companion covers an `@click` in the host, and an `@click` in a companion
is judged too. `hardcoded-text` judges each module on its own, so a
`// furnace-ignore: hardcoded-text` comment covers the file it is in, not
its siblings. Toolkit's `panel-item` counts as natively
keyboard-activated, beside `button`, form controls and the `moz-*` buttons.

`minComponents` sets the fewest components a full `furnace validate` must
judge. A run under it, an empty tree included, fails with a
`component-floor` error on `furnace.json`, so a moved or emptied
components tree cannot pass by validating nothing. A run naming one
component is not held to it.

```json
{ "minComponents": 40 }
```

`optInChecks` turns on checks that are off by default:

```json
{ "optInChecks": ["icon-button-label"] }
```

`icon-button-label` warns about an icon-only `<moz-button>` in a component's
Lit templates (one with an `iconsrc` or an `icon` type, and no `label` or
text content) that has neither `data-l10n-id` nor `aria-label`, so a screen
reader would announce it only as "button". A button built with
`document.createElement` is not seen.

## Safety

Every furnace mutation runs through `runFurnaceMutation`, which gives it a
per-root lock, a rollback journal restored on both a signal and a thrown
error, and a `pendingRepair` marker that blocks further mutations when a
rollback was incomplete. Clear the marker with
`fireforge doctor --repair-furnace`. The full contract, including which
commands take which locks, is in
[`lifecycle-invariants.md`](lifecycle-invariants.md).

`apply`, `deploy` and `sync` accept `--wait-lock [seconds]`, and that budget
covers both locks they take. The leaves that take only the furnace lock
(`create`, `remove`, `rename`, `refresh`, `scan`, `override`, `preview` and
the `chrome-doc` pair) apply the flag to that lock. Without the flag, the
session budget from `FIREFORGE_WAIT_LOCK` applies. See
[`configuration.md`](configuration.md#lock-waits).

`build` and `test` rewrite deployed component files from their sources before
building, and `--refuse-unexported-drift` refuses when that would destroy
engine content no patch records. A deployed file that is a Furnace deployment
of its own source is classified `deployed-unexported` and allowed: it equals
the composed current source, differs from it only inside generated fragment
expansions, or is exactly what the last recorded apply deployed. Those files
are listed in an informational note, since their patches still owe a
re-export. Only content that matches no patch body, no baseline and none of
these source forms is refused.
