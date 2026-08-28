<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Furnace components

Furnace is FireForge's answer to UI components. It tracks stock widgets,
creates new fork-owned widgets, and overrides existing ones. The files still
land inside the Firefox source directory and end up as part of the regular
patches to export.

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

Cross-widget CSS can be single-sourced. Place the fragment in
`components/shared/` and reference it from a widget stylesheet with a
comment:

```css
/* @fireforge-include base-button.css */
```

`deploy` expands it into the deployed copy only, so editing the fragment
surfaces as component drift until the next deploy.

## Typed cross-module imports

For multi-file components, set `furnace.json#typecheckJsconfig` to a
consumer-owned jsconfig. `deploy` then maintains `compilerOptions.paths`
entries mapping each deployed
`chrome://global/content/elements/<file>.mjs` URL to its workspace source.

Entries are recognized as Furnace-managed by containment in the components
workspace, so a hand-written entry is preserved and a managed entry whose
helper was deleted is pruned.

## Safety

Every furnace mutation runs through `runFurnaceMutation`: a per-root lock, a
rollback journal restored on both a signal and a thrown error, and a
`pendingRepair` marker that blocks further mutations when a rollback was
incomplete — cleared with `fireforge doctor --repair-furnace`. The full
contract, including which commands take which locks, is in
[`lifecycle-invariants.md`](lifecycle-invariants.md).

`apply`, `deploy` and `sync` accept `--wait-lock [seconds]`, whose budget
covers **both** locks they take. The twelve mutators without the flag pick up
a session budget from `FIREFORGE_WAIT_LOCK`; see
[`configuration.md`](configuration.md#lock-waits).
