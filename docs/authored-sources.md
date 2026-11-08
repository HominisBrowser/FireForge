# Source mode

Source mode (`sources.mode: "authored"`) keeps your owned files as ordinary tracked files under `src/`. Upstream policy judges the exact delta against a pinned pristine commit. Patches are generated output (`authored export-queue`); daily editing needs no patch rows, numbering or export. Builds, tests and checks run as [jobs](jobs-and-slots.md).

```json
{
  "sources": {
    "schemaVersion": 1,
    "mode": "authored",
    "root": "src",
    "metadataRoot": ".fireforge-sources",
    "pristineCommit": "<complete pristine Git commit id>"
  },
  "test": { "reapOrphans": "owned" }
}
```

`test.reapOrphans: "owned"` is required with `sources`, so a FireForge that does not understand source mode rejects the file instead of ignoring `sources`. The pin changes only by a reviewed edit to `fireforge.json` or an adopted [refresh proposal](#refreshing-the-pin); `config` cannot write `firefox` or `sources` in source mode.

A source path maps directly to its engine path: `src/browser/modules/X.sys.mjs` supplies `browser/modules/X.sys.mjs`. Paths must be canonical and contained; links, submodules, case collisions and unsupported modes are refused. Regular and executable files keep their bytes. `src/.gitattributes` holds `* -text`; capture refuses a file whose `text`, `eol`, `filter`, `ident` or `working-tree-encoding` attribute could change committed bytes.

## Output

Every `authored` command prints human text by default. `--json` writes exactly one JSON document with `schemaVersion`, and failures as `{schemaVersion, error, code}`. `authored delta` prints the delta text, or `{delta}` with `--json`. Commands that need a queue project's source say `fireforge authored migrate --out <directory> --verify`.

## Overriding upstream files

An override is a small record at `.fireforge-sources/overrides/<engine path>.json` (a sidecar) holding the exact Firefox pin, pristine commit, upstream blob and mode, component identity, classification and any exception ADR. Validation reads the actual upstream objects.

```sh
fireforge authored override browser/base/jar.mn
fireforge authored override browser/base/jar.mn --component ui-chrome
fireforge authored override path/to/upstream.cpp --component reviewed-exception \
  --classification exception --adr docs/architecture/adr/reviewed-exception.md
fireforge authored override path/to/upstream-file --classification exception --adr <adr> --delete
fireforge authored restore-upstream path/to/upstream-file [--discard]
```

`--component` defaults to the path's top directory and `--classification` to `registration`. An override starts with pristine bytes; an existing undeclared edit is refused, so move it aside, declare, then reapply. An exception needs its approved ADR to exist and does not bypass the project's allowlists, markers, scope or quality checks. `--delete` is an explicit upstream tombstone; `restore-upstream` removes the postimage (the file's owned bytes) and record, and refuses uncommitted edits unless `--discard`. The next materialization restores upstream bytes. A stale base, an orphaned record, an upstream collision or ambiguous removal refuses acceptance.

Two branches that first-touch one upstream file would conflict `add/add` over the whole file. `src/.gitattributes` routes source files through `fireforge authored merge-driver`, which merges against the recorded pristine blob; overlapping edits leave ordinary conflict markers, and differing records conflict as usual. `authored override` installs the driver in the repository's Git configuration the first time, and `authored merge-install` does it explicitly. Without it, Git reports the conflict it always would.

## Capture and review

```sh
fireforge authored capture --out .fireforge/snapshots/current.json
fireforge authored delta --snapshot .fireforge/snapshots/current.json --upstream
fireforge authored validate --snapshot .fireforge/snapshots/current.json
fireforge authored status
```

A snapshot is what a commit of the checkout would hold, built with a private index that moves nothing in your repository. Capture always selects source, records, `components/`, `configs/`, `fireforge.json`, `furnace.json`, `package.json` and `package-lock.json`; `--path` adds more. It takes tracked and untracked files with deletions and without ignored ones, so two clean checkouts of one commit give one snapshot. It refuses, by name:

- an ignored file under the source or metadata root (fix `.gitignore` or delete it; `.DS_Store`-style droppings are exempt);
- a tracked file changed outside the selection (commit it, add `--path`, or `--allow-dirty-root` to prove its committed bytes);
- a tracked file under a top-level `.git`, `engine`, `node_modules`, `.fireforge` or `secrets`.

`authored status` reports the snapshot ID and per-kind counts without retaining a ref. `authored prune --keep <count>` releases old retained snapshots, keeping any a job or slot uses.

### Donors

Reading upstream objects needs a pristine donor (a Git repository holding the pinned commit; it is only read). Commands find one in this order: `--pristine-repository <path>`, `FIREFORGE_PRISTINE_REPOSITORY`, the template this host keeps for the pin, the checkout's `engine/`, then the main checkout's `engine/` from a linked worktree. Once a template exists, `engine/` can be deleted.

```sh
fireforge authored pristine fetch --out ~/.fireforge/pristine/current --from /path/or/url
fireforge authored pristine fetch --out /prepared/new-pristine --pin new-pin.json
```

`--from` copies the pinned commit from a repository that holds it. Without it, the Firefox archive is downloaded, checksum-verified and imported as one commit with fixed metadata, so every host reaches the same commit ID. `--pin` names another firefox configuration (`{"firefox": {...}, "commit"?}`). The destination must be outside the project; an import that does not reproduce the requested commit leaves nothing.

### Static feedback

```sh
fireforge authored lint [paths...]
fireforge authored typecheck [paths...]
fireforge authored verify
```

These judge the current checkout (or `--snapshot <file>`) in-process, in a private view under `.fireforge/feedback/`, with no slot, job or namespace. Top-level `lint`, `typecheck`, `verify` and `status` do the same in an editing checkout. Bare `typecheck` runs strict source typing and says that `typecheck.projects` wait for a job (they read upstream through `engine/`); `--project` runs one on the view anyway. `authored lint` exits nonzero over `check.maxWarnings.lint`, the line `check` and `prove` hold. Findings are feedback, never evidence: only a sealed job produces a receipt, and a check that needs an upstream file outside the source can differ in a job.

Strict typing (`patchLint.checkJs`) covers created files and generated ones with no upstream counterpart; an override's delta goes through content rules instead. An exception ADR's `allowed.files` must list every upstream path its component changes, and any other listed path must be a captured created file.

## Command boundaries

In source mode the editing checkout owns tracked source. Legacy patch commands (`export`, `export-all`, `re-export`, `import`, `reset`, `discard`, `park`, `patch`, `rebase`, `resolve`, `watch`, `setup`, source-pin changes, `download`, `bootstrap`) refuse, including dry runs. An execution slot is immutable to direct editing even if its captured configuration lacks `sources`.

| Command                                                                     | Editing checkout           | Slot (inside a job) | Refused                                      |
| --------------------------------------------------------------------------- | -------------------------- | ------------------- | -------------------------------------------- |
| `authored capture\|status\|delta\|validate\|lint\|typecheck\|verify\|prune` | yes, from a snapshot       | not needed          |                                              |
| `authored override\|restore-upstream\|merge-install\|merge-driver`          | yes                        |                     | in a slot                                    |
| `authored migrate\|refresh\|pristine fetch\|export-queue`                   | yes, outside the checkout  | not needed          | destination inside the checkout or a slot    |
| `authored materialize`                                                      | isolated destination only  |                     | overwriting a managed slot                   |
| `status`, `lint`, `typecheck`, `verify`                                     | yes, from a snapshot       | yes                 |                                              |
| `register`, `wire`, `token` authoring, `furnace create\|types`              | yes (edit tracked source)  |                     | in a slot                                    |
| `build`, `test`, `check`, `run`, `package`, `furnace apply\|deploy\|sync`   | no                         | yes, as a job       | directly                                     |
| `furnace override`, `furnace refresh`                                       |                            |                     | use `authored override` / `authored refresh` |
| `furnace chrome-doc`, `furnace remove`, `furnace rename`                    | edit source and components | via a job           | live deployment edits in an editing checkout |

A dry-run flag grants no write. A command with no classification refuses inside source projects and slots. `status --check` needs a slot to judge.

## Furnace and writers

Component and fragment files stay authoritative under `components/`; composition derives widget and locale output from captured inputs into a separate generated tree. A path cannot be both authored and generated, and a generated change to upstream still needs a record. `furnace create` scaffolds tests (xpcshell, browser-chrome, MochiKit) in tracked source.

The typecheck files Furnace generates (`typecheckJsconfig` paths and `typecheckTagMap`) are tracked files, not composition output, and a slot uses the committed copies as captured. `furnace types` writes them in the editing checkout; a configured `engine/<path>` is written to `<sources.root>/<path>`. `furnace validate`, and so `check`, fails while a committed copy differs from what the workspace generates, and `typecheck` in a job leaves it as it is. `furnace types --check` gives the same answer without a slot. A tag map outside the captured roots is missing in a slot unless a proof input or `--path` captures it.

Registration, wire and token helpers write tracked source and need a declared override. Each writer checks the bytes it expects before replacing a file and takes a cooperative per-path lock, and a later writer that finds different bytes refuses. Editors do not take the lock, so finish direct edits before concurrent runs.

## Materialize

```sh
fireforge authored materialize --snapshot s.json --engine /isolated/engine [--ledger <path>]
```

The destination must already hold the authenticated pristine tree (slots are seeded this way). Materialization verifies existing outputs against its ledger, writes only changed paths under a rollback journal, restores removed overrides, deletes removed created outputs and keeps executable modes. An interrupted run recovers on the next invocation; an outside edit matching neither image is kept and reported as `authored-recovery-drift`.

## Exporting a patch queue

```sh
fireforge authored export-queue --snapshot s.json --out /public/patches
```

Writes `patches.json` and the patches into an absent or empty directory, deterministically. It replays the queue onto the pinned pristine bytes and refuses `authored-export-queue-mismatch` unless every path matches the snapshot. A legacy project at the same Firefox pin takes the directory as `patches/` and `fireforge import` reproduces the snapshot: the route for public export, CI and rolling back an adoption.

Each path is in exactly one patch, and a patch's name and bytes depend only on its own files:

- Each upstream component is one patch, `001-<component>.patch` (a leading number and `.patch` in the component's name are dropped).
- Created files, and generated files with no upstream counterpart, follow as `002-` patches: [`exportQueue.groups`](configuration.md#exportqueue) first, first match wins, then by directory within `exportQueue.maxGroupBytes`.
- Patches of one order apply in name order. Components share no path, and created files apply after them because one can take the place of an upstream path a component deletes.
- `patches.json` names the snapshot once, as `source.snapshot`.

So an edit to one file changes that file's patch and `source`, and a new group adds a patch without renaming any other. A directory group that grows past the budget splits into smaller patches, changing only that directory's patches. Two groups that would get the same file name refuse `authored-export-queue-name-collision`.

## Migrating a queue project

```sh
fireforge authored migrate --out /separate/migration --verify --pristine-repository /prepared/donor
```

Migration replays the recorded queue in a disposable repository and writes a separate overlay; it never captures live engine drift or changes your project. Overrides become postimages plus records, explicit deletions become tombstones, Furnace output stays generated. The pin defaults to an archive donor's commit (matching the project's Firefox version, product and checksum), then the recorded base commit, then donor HEAD; `--pristine-commit` overrides. `pinSource` reports which applied and `pinReproducible` whether another host can rebuild the donor from the archive alone. Every record carries the pin, so choose before adopting: `authored pristine fetch --out <directory>` works on a queue project and gives a reproducible donor.

`--verify` commits the overlay in a scratch project, captures and materializes it, and compares every path's bytes and mode with the replayed queue before publishing.

The output holds `src/`, `.fireforge-sources/`, `legacy-manifest.json` (the original manifest, archived), a `policy.json` that starts as a pending-review proposal, and `fireforge.fragment.json` (the `sources` and `test` keys). To adopt: merge the fragment, copy `src/` and `.fireforge-sources/` into the project, remove `patches/`, run `fireforge authored merge-install`, review each retained or retired policy rule (an approved ADR, a reasoned decision per legacy scope rule, explicit retirement of created-patch budgets), then run the required gates. Land the adoption on the main branch. A branch with queue changes in flight migrates into its own directory and its difference from the main overlay lands as an ordinary commit.

An archive import stages everything the archive holds (including files upstream's `.gitignore` hides) and refuses a tree that differs from the archive's file list; `fireforge download` does not, because a built legacy engine would take in the objdir.

## Refreshing the pin

```sh
fireforge authored refresh --snapshot old.json --pristine-repository /old-pristine \
  --new-pristine-repository /new-pristine --new-pin new-pin.json --out /separate/empty/proposal
```

`new-pin.json` is `{"firefox": {"version": "...", "product": "firefox-esr", "sha256": "..."}, "commit": "<full new pristine commit>"}`. Donors are only read. The command three-way merges old pristine, your source and new pristine, and writes a proposal directory; it never changes your source, index, HEAD or pin. `authored-refresh-proposal.json` holds each path's outcome, and a conflicted path's `conflictFiles` are under `conflicts/` (merge markers, or `.base`, `.local` and `.upstream` sides). Text conflicts, competing binary edits, delete/edit conflicts, new upstream collisions and removals needing reclassification are explicit; a tombstoned deletion retires cleanly. A conflicted proposal cannot be accepted until resolved. Adoption is a separate reviewed project change followed by the complete refresh drill.
