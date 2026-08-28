<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Verification trees

For concurrent read-mostly verification beside a busy primary checkout,
`fireforge tree create <name>` snapshots the project — applied engine tree
included, `obj-*` excluded — into `.fireforge/trees/<name>` using filesystem
copy-on-write (APFS `clonefile`, btrfs/XFS reflink). Roughly 3 s for a 156 MB
applied browser tree.

```bash
npx fireforge tree create verify
npx fireforge tree exec verify -- npx fireforge lint --per-patch
npx fireforge tree list
npx fireforge tree remove verify
```

## What works inside a tree

Read-only commands and `export`/`re-export` dry runs. **Mutations are
refused** — a default-deny verdict table, not a blocklist, so a newly added
mutating command is refused until it is classified. That is invariant 7 in
[`lifecycle-invariants.md`](lifecycle-invariants.md).

`--with-objdir` adds a safely relocated build, which makes build-less `test`
possible inside the tree.

## Lifecycle

- `tree list` reports staleness (`--json`; see
  [`machine-output.md`](machine-output.md)).
- `tree remove` deletes, refusing an active lock and a lock of unknown
  ownership.
- `tree exec <name> -- <cmd>` runs a command inside a tree, sealing its stdout
  so exactly one verdict line survives, last.

## Filesystems without CoW

Refused unless `--force-copy` explicitly accepts a full physical copy. The
refusal is the point: a silent full copy of an applied browser tree is not
the operation anyone asked for.

## The tree marker

`.fireforge/tree.json` is tri-state: absent (primary), valid (snapshot), or
**corrupt**. A corrupt marker refuses every command, because an unreadable
marker leaves it unknown whether this is a snapshot or the primary tree.
`--ignore-corrupt-tree-marker` overrides that deliberately.
