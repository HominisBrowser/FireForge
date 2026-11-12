<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Furnace components

Furnace manages the fork's UI components: custom elements the fork adds, and overrides of Firefox's stock widgets. Their sources live in the project under `components/`, described by `furnace.json`; Furnace deploys them into the engine a command builds in, validates them, scaffolds, renames and removes them, and generates the typing files that make them typed for the code that uses them. It works the same in both modes.

```sh
npx fireforge furnace create moz-my-widget -d "A widget" --localized --tests browser-chrome
npx fireforge furnace override moz-button --css-only -d "Brand colours"
npx fireforge furnace status
npx fireforge furnace validate
npx fireforge build --ui
```

## Layout

```
furnace.json
components/
  custom/moz-my-widget/      moz-my-widget.mjs, moz-my-widget.css, moz-my-widget.ftl, moz-my-widget-*.mjs
  overrides/moz-button/      the copied stock files you edit
  shared/                    CSS fragments several components include
```

`furnace.json` is created with `"componentPrefix": "moz-"` the first time a command writes it. Its full schema is in [configuration.md](configuration.md#furnacejson).

## Creating and overriding

`furnace create <tag>` writes a custom component: `<tag>.mjs` (a class extending `MozLitElement` that calls `customElements.define`), `<tag>.css`, and with `--localized` its own `<tag>.ftl`, plus its `furnace.json` entry. The tag must start with `componentPrefix`.

- `-d, --description <text>`: what the component is.
- `--localized`: give it its own Fluent file. `--shared-ftl <path>` shares an existing feature Fluent file instead.
- `--register` (the default) lists the element in `toolkit/content/customElements.js` so it is defined lazily; `--no-register` leaves it out.
- `--compose <tag>`: a component it renders in its template.
- `--tests browser-chrome|mochikit|xpcshell`: scaffold a test in that harness and register it in its manifest.
- `--dry-run`: show what would change.

`furnace override <name>` copies a stock component from the engine (`toolkit/content/widgets/<name>`, or `--from <dir>`) into `components/overrides/<name>/` and records the Firefox version it was taken from. `--css-only` copies and deploys only its stylesheets.

`furnace rename <from> <to>` renames a component, its files, its tests and every reference to it. `furnace remove <name>` removes a component, its tests and its `furnace.json` entry. Each of these is one transaction over `components/`, `furnace.json`, the typing files and the component's tests. None of them touches a workspace; the next deployment adds and removes what changed.

In source mode the engine files a component brings along (its tests and their manifests) are written under `src/`, and a first edit of an upstream manifest declares its override as a registration.

## Deploying

`build`, `test`, `run`, `package`, `watch` and `gate` deploy the components into their workspace before they start, so you rarely deploy by hand. `furnace apply` does it on its own:

```sh
npx fireforge furnace apply --dry-run
npx fireforge furnace apply
```

Deployment compares what the components want the engine to hold with what it holds, and writes the difference in one transaction:

- each custom component's files into `toolkit/content/widgets/<tag>/` (or its `targetPath`), and its Fluent file into `ftlBasePath` (default `toolkit/locales/en-US/toolkit/global`);
- each override's files over the stock files;
- one `toolkit/content/jar.mn` line per module and stylesheet of a custom component, packaged as `chrome://global/content/elements/<file>`;
- one `customElements.js` entry per registered element, in the list that matches how it loads (ES modules in the list imported on `DOMContentLoaded`).

A deployment record in the workspace says what each component deployed, so a deployed file the component does not have, or a component `furnace.json` does not list, is taken away, and an override's file goes back to the upstream bytes. Everything else is decided from the bytes on disk: an unchanged component costs a read and a hash, and a reset engine or a lost record is repaired by the next deployment.

`furnace status` lists the components and whether the engine holds them as the project has them. `furnace diff [name]` shows how a custom component differs from its deployed copy, or an override from the stock files.

## Shared CSS fragments

Shadow DOM gives every widget stylesheet its own copy of shared rules. Put them in `components/shared/` and include them from a component stylesheet with a directive on its own line:

```css
/* @fireforge-include base-button.css */
```

The deployed copy has the fragment inlined after the directive and fenced by an end marker; the project's source keeps only the directive. Editing a fragment changes the deployed content of every component that includes it.

## Validating

```sh
npx fireforge furnace validate
npx fireforge furnace validate moz-my-widget --max-warnings 0
```

`furnace validate` checks every component against the rules below and ends with a verdict line. Errors fail; warnings fail past `--max-warnings` (or `check.maxWarnings.furnace` inside `check`). The accessibility checks read the composed component (`<tag>.mjs` and its `<tag>-*.mjs` modules together) and are heuristics over source text.

| Check                           | Severity | Finds                                                                                                 |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `missing-mjs`                   | error    | A custom component without `<tag>.mjs`                                                                |
| `missing-css`                   | warning  | A component without `<tag>.css`                                                                       |
| `missing-ftl`                   | error    | A localized component without its `.ftl` (and no `sharedFtl`)                                         |
| `conflict-markers`              | error    | Unresolved merge conflict markers                                                                     |
| `filename-mismatch`             | error    | Files not named `<tag>.*` or `<tag>-*`                                                                |
| `missing-fragment`              | error    | An include of a fragment `components/shared/` does not have                                           |
| `no-aria-role`                  | warning  | Generic interactive markup without native semantics or `role=`                                        |
| `no-keyboard-handler`           | warning  | `@click` without a keyboard handler                                                                   |
| `hardcoded-text`                | warning  | Text that should be a `data-l10n-id` (a `// furnace-ignore: hardcoded-text` comment exempts a module) |
| `no-delegates-focus`            | warning  | An interactive component without `delegatesFocus`                                                     |
| `positive-tabindex`             | warning  | A positive `tabindex`                                                                                 |
| `unlabelled-form-input`         | warning  | A form input without an accessible label                                                              |
| `icon-button-label`             | warning  | An icon-only `<moz-button>` without an accessible name; runs only when `optInChecks` lists it         |
| `relative-import`               | error    | A relative import instead of a `chrome://` or `resource://` URL                                       |
| `no-custom-element-define`      | error    | A module that never calls `customElements.define()`                                                   |
| `not-moz-lit-element`           | error    | A class that does not extend `MozLitElement`                                                          |
| `raw-color-value`               | error    | A raw colour instead of a design token                                                                |
| `token-prefix-violation`        | error    | A `var()` outside the token prefix, `tokenAllowlist` and `runtimeVariables`                           |
| `excessive-important`           | warning  | More than three `!important`                                                                          |
| `missing-reduced-motion`        | warning  | An animation or transition without a `prefers-reduced-motion` query                                   |
| `prefers-color-scheme`          | warning  | A `prefers-color-scheme` query; theme through tokens instead                                          |
| `compose-not-referenced`        | warning  | A `composes` entry the template and stylesheet never reference                                        |
| `override-base-version-drift`   | error    | An override taken from another Firefox version than the project builds                                |
| `missing-component-dir`         | error    | A `furnace.json` entry whose directory is missing or empty                                            |
| `component-floor`               | error    | Fewer components judged than `minComponents`                                                          |
| `typing-drift`                  | error    | A generated typing file out of date                                                                   |
| `deployment-stale`              | error    | The engine does not hold a component as the project has it                                            |
| `validation-exception-on-error` | error    | A `validationExceptions` entry that matches an error                                                  |
| `stale-validation-exception`    | warning  | A `validationExceptions` entry that matches nothing                                                   |

`furnace.json#validationExceptions` accepts reviewed warnings: `{ "component", "check", "reason" }`, narrowed with `tag` or `file`. An exception never accepts an error.

```json
{
  "validationExceptions": [
    {
      "component": "moz-my-widget",
      "check": "hardcoded-text",
      "file": "moz-my-widget-debug.mjs",
      "reason": "Developer-only panel, not shipped in release"
    }
  ]
}
```

## Typing files

```sh
npx fireforge furnace types
npx fireforge furnace types --check
```

`furnace types` writes two files from the components, so code that imports a component module or creates its element is typed:

- `typecheckJsconfig`: in each named `jsconfig.json`, a `compilerOptions.paths` entry per component module, mapping its chrome URL to its source in `components/custom/`. Other entries are left alone.
- `typecheckTagMap`: a declaration file adding each registered element whose module exports its class to `HTMLElementTagNameMap`. Furnace owns the whole file.

A path starting `engine/` names the project's tracked copy of that engine file (`engine/` itself in patch mode, `src/` in source mode); any other path is relative to the project root. `--check` writes nothing and fails while a file is out of date. `typecheck`, `furnace validate` and `doctor` all refuse or report stale typing files.

See [authoring.md](authoring.md) for design tokens, manifest registration and chrome script wiring.
