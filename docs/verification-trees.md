<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Verification trees

To run read-mostly verification beside a busy primary checkout,
`fireforge tree create <name>` snapshots the project into
`.fireforge/trees/<name>` using filesystem copy-on-write (APFS `clonefile`,
btrfs/XFS reflink). The applied engine tree is included and `obj-*` is excluded.

```bash
npx fireforge tree create verify
npx fireforge tree exec verify -- npx fireforge lint --per-patch
npx fireforge tree list
npx fireforge tree remove verify
```

Inside a tree, read-only commands work, as do `export` and `re-export` dry runs.
Mutations are refused by a default-deny table, so a newly added mutating command is
refused until it is classified. `--with-objdir` adds a relocated build, which makes
a build-less `test` possible inside the tree.

- `tree list` reports staleness (`--json`, see [`machine-output.md`](machine-output.md)).
- `tree remove` deletes a tree, and refuses when a lock is active or its ownership
  is unknown.
- `tree exec <name> -- <cmd>` runs a command inside a tree and seals its stdout, so
  exactly one verdict line survives, last.

A filesystem without copy-on-write is refused unless `--force-copy` accepts a full
physical copy.

`.fireforge/tree.json` is absent (this is the primary), valid (a snapshot) or
corrupt. A corrupt marker refuses every command, since it leaves unknown whether
this is a snapshot or the primary; `--ignore-corrupt-tree-marker` overrides that.
