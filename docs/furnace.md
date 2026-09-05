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
fragment shows up as component drift until the next deploy.

## Typed cross-module imports

For multi-file components, set `furnace.json#typecheckJsconfig` to a
consumer-owned jsconfig. `deploy` then maintains `compilerOptions.paths`
entries that map each deployed
`chrome://global/content/elements/<file>.mjs` URL to its workspace source.

An entry counts as Furnace-managed if it is contained in the components
workspace. A hand-written entry is therefore preserved, and a managed entry
whose helper was deleted is pruned.

## Safety

Every furnace mutation runs through `runFurnaceMutation`, which gives it a
per-root lock, a rollback journal restored on both a signal and a thrown
error, and a `pendingRepair` marker that blocks further mutations when a
rollback was incomplete. Clear the marker with
`fireforge doctor --repair-furnace`. The full contract, including which
commands take which locks, is in
[`lifecycle-invariants.md`](lifecycle-invariants.md).

`apply`, `deploy` and `sync` accept `--wait-lock [seconds]`, and that budget
covers both locks they take. The twelve mutators without the flag pick up a
session budget from `FIREFORGE_WAIT_LOCK`. See
[`configuration.md`](configuration.md#lock-waits).
