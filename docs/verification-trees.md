<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Verification trees

To run read-mostly verification beside a busy primary checkout,
`fireforge tree create <name>` snapshots the project into
`.fireforge/trees/<name>` using filesystem copy-on-write (APFS `clonefile`,
btrfs/XFS reflink). The applied engine tree is included and `obj-*` is
excluded. A 156 MB applied browser tree takes roughly 3 seconds.

```bash
npx fireforge tree create verify
npx fireforge tree exec verify -- npx fireforge lint --per-patch
npx fireforge tree list
npx fireforge tree remove verify
```

## What works inside a tree

Read-only commands, plus `export` and `re-export` dry runs. Mutations are
refused. The refusal comes from a default-deny verdict table rather than a
blocklist, so a newly added mutating command is refused until someone
classifies it. That is invariant 7 in
[`lifecycle-invariants.md`](lifecycle-invariants.md).

`--with-objdir` adds a safely relocated build, which makes a build-less
`test` possible inside the tree.

## Lifecycle

- `tree list` reports staleness (`--json`, see
  [`machine-output.md`](machine-output.md)).
- `tree remove` deletes a tree, and refuses when a lock is active or its
  ownership is unknown.
- `tree exec <name> -- <cmd>` runs a command inside a tree and seals its
  stdout, so exactly one verdict line survives, last.

## Filesystems without CoW

These are refused unless `--force-copy` explicitly accepts a full physical
copy. The refusal is there on purpose: a silent full copy of an applied
browser tree is not the operation anyone asked for.

## The tree marker

`.fireforge/tree.json` has three states: absent (this is the primary), valid
(this is a snapshot), or corrupt. A corrupt marker refuses every command,
because an unreadable marker leaves it unknown whether this is a snapshot or
the primary tree. `--ignore-corrupt-tree-marker` overrides that.
