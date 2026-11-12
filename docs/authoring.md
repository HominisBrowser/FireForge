<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Authoring helpers: tokens, registration, wiring

Three helpers edit Firefox's own files the way Firefox's conventions expect, so you do not hand-edit build manifests and chrome scripts. Each plans every edit before writing any, and `--dry-run` shows the plan.

They write where the project keeps engine files: `engine/` in patch mode, `src/` in source mode. In source mode an upstream file needs an override record before it is edited ([source-workflow.md](source-workflow.md#declaring-an-upstream-file-override)). `register` and `wire`, whose edits are registrations by definition, declare that override themselves (classified `registration`) on their first edit of an upstream file. `token add` refuses an upstream file without one and names the `override` command.

## Design tokens: `token`

A design token is a CSS custom property the project declares in one token file and uses everywhere else. The token commands read two keys of `furnace.json`:

- `tokenFile`: the engine path of the token file. Default `browser/themes/shared/<binaryName>-tokens.css`.
- `tokenPrefix`: the prefix every project token starts with. Default `--<binaryName>-`.

The token file's base `:root` block is divided into categories by banner comments, one line (`/* = Spacing = */`) or a boxed block whose first text line is the name. Themed blocks (the dark `@media (prefers-color-scheme: dark)` mirror, `:root[<variant>]` blocks) override values.

```sh
npx fireforge token list
npx fireforge token show -- --mybrowser-gap
npx fireforge token add --category Spacing --mode static -- --mybrowser-gap 8px
npx fireforge token add --category Colors --mode override --dark-value '#1c1b22' -- --mybrowser-surface '#ffffff'
npx fireforge token add --variant '[data-skin=compact]' -- --mybrowser-gap 4px
```

Token names start with `--`, which the option parser would read as a flag, so put `--` before the name. A bare name (`gap`) takes the project prefix.

`token add <name> <value>`:

- `--category <name>`: the banner to add the token under. `--create-category` declares the banner when the file has none by that name.
- `--mode auto|static|override`: dark-mode behaviour. `auto` follows the platform, `static` never changes, `override` has its own dark value (`--dark-value`), written into the dark-mode and theme-attribute blocks.
- `--description <text>`: a comment written above the declaration.
- `--variant <selector>`: add the declaration to the `:root<selector>` block instead.

`token list [--category <name>]` lists categories and tokens. `token show <name>` shows every value a token takes and where each is declared.

### Checking token use

```sh
npx fireforge token lint
npx fireforge token coverage --min 80
```

`token lint` runs two checks:

- `token-lockstep`: a themed block declares only tokens the base `:root` declares; otherwise every other theme resolves the token to nothing.
- `token-undeclared`: a `var(--<prefix>...)` in the token file or an owned stylesheet names a token nothing declares. Declarations in the same sheet or in a sibling sheet, a reference with a fallback, and the names in `tokenAllowlist` and `runtimeVariables` do not count.

Sibling sheets are stylesheets that load together: linked from one document (`<link rel="stylesheet">`, `<?xml-stylesheet?>`), or one `@import`ing the other. `tokenSiblingSheets` adds pairings no link shows.

`token coverage` measures how many values in the owned stylesheets come from a project token, against raw colours and custom properties nobody the project knows declares. `--min <percent>` fails below that share. Both run as steps of `fireforge check` (`token-lint`, `token-coverage`, with `check.minTokenCoverage`).

Inside owned changes, the lint rules `raw-color-value`, `token-prefix-violation` and `token-scale` enforce token use line by line ([quality.md](quality.md#rules)).

## Build-manifest registration: `register`

A file Firefox should package or run must be listed in a build manifest. `register` works out which one from the path and adds the entry:

```sh
npx fireforge register browser/base/content/mybrowser/panel.js
npx fireforge register browser/modules/Sidebar.sys.mjs
npx fireforge register browser/base/content/test/sidebar/browser_focus.js
npx fireforge register browser/base/content/test/sidebar/browser.toml --create-manifest
```

| The file is                          | It is registered in                       |
| ------------------------------------ | ----------------------------------------- |
| chrome content, skin or widget files | the `jar.mn` that packages that directory |
| a JavaScript module                  | the `moz.build` of its directory          |
| a test manifest                      | the `moz.build` above it                  |
| a test file                          | the test manifest of its directory        |

A file that is already registered is left alone.

- `--after <entry>` places the entry after an existing one (`jar.mn` and test manifests).
- `--create-manifest` creates a missing `moz.build` or test manifest and wires it into its parents.
- `--dry-run` shows the planned edit.

Lint's `dangling-registration` and `unregistered-system-module` rules catch registrations that name missing files and modules nothing installs.

## Chrome script wiring: `wire`

`wire <name>` wires a chrome subscript into the browser window:

```sh
npx fireforge wire mybrowser-sidebar --init MyBrowserSidebar.init --destroy MyBrowserSidebar.uninit --dom browser/base/content/mybrowser-sidebar.inc.xhtml
```

It makes these edits, all planned before any is written:

- loads `<name>.js` from `browser-main.js`;
- with `--init <expression>`, calls it from `onLoad` in `browser-init.js`, after the init block of `--after <name>` when given;
- with `--destroy <expression>`, calls it from `onUnload`;
- with `--dom <path>`, `#include`s that DOM fragment (`.inc.xhtml`) into the top-level chrome document;
- registers the script in `browser/base/jar.mn`.

The scripts live in `wire.subscriptDir` (default `browser/base/content`) and fragments are included into `wire.domTarget` (default `browser/base/content/browser.xhtml`). Every edit parses the file it changes, so a file that does not parse is refused rather than patched by guesswork. Lines FireForge writes into upstream files carry the `markerComment` comment.
