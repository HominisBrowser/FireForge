<!-- SPDX-License-Identifier: EUPL-1.2 -->

# The gate

`fireforge gate` is the judgement before a push: `check`, a build, and every test lane, stress run, negative control and smoke start `fireforge.json` declares, run on a clean committed tree. When everything passes and every declared acceptance is recorded, the git ref `refs/fireforge/verified` moves to the commit. A pre-push hook can then refuse any push whose tree is not the verified tree.

```sh
git commit -am "Sidebar: keyboard navigation"
npx fireforge gate
```

The gate works the same in both modes. It leases one workspace for the whole run ([workspaces.md](workspaces.md)).

## Configuration

Everything the gate runs besides `check` is declared under `gate` in `fireforge.json`:

```json
{
  "gate": {
    "build": "ui",
    "documents": ["docs/**", "*.md"],
    "lanes": [
      {
        "id": "sidebar",
        "files": ["browser/base/content/test/sidebar/browser.toml"],
        "dispatch": "shards"
      },
      {
        "id": "captures",
        "files": ["browser/base/content/test/captures/**/browser_*.js"],
        "headed": true,
        "uploadDir": true,
        "env": { "CAPTURE_DIR": "{artifacts}/captures" },
        "machArgs": ["--setpref=layout.css.devPixelsPerPx=2"],
        "validate": { "command": ["node", "scripts/check-captures.mjs", "{artifacts}/captures"] }
      }
    ],
    "stress": [
      {
        "id": "sidebar-x5",
        "files": ["browser/base/content/test/sidebar/browser.toml"],
        "repeat": 5
      }
    ],
    "controls": [
      {
        "id": "sidebar-focus",
        "diff": "controls/sidebar-focus.diff",
        "test": "browser/base/content/test/sidebar/browser_focus.js",
        "assertions": ["focus moves to the first item"]
      }
    ],
    "runs": [
      {
        "id": "startup",
        "smokeExit": 20,
        "headless": true,
        "consoleAllowFile": "configs/console-allow.txt"
      }
    ],
    "acceptance": [
      {
        "id": "visual",
        "reason": "The sidebar matches the design at 2x",
        "evidence": ["lane:captures"]
      }
    ]
  }
}
```

### `build`

`ui` (the default) or `full`. A workspace that needs a full build gets one either way.

### `documents`

Globs of repository paths that change nothing the gate tests. A pattern without a slash matches a file name at any depth. A commit whose every change since the verified commit matches these needs `check` alone.

### `lanes`

A lane is a group of tests run as declared. It is data, not a shell line.

| Key         | Meaning                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Lowercase ID (`a-z`, `0-9`, `.`, `_`, `-`)                                                                                                  |
| `files`     | Engine-relative globs or literal paths of test files, directories or manifests                                                              |
| `exclude`   | Tests left out of `files`                                                                                                                   |
| `dispatch`  | `shards` (a browser per mochitest file, the default), `one-browser`, or `standalone` (one invocation, restarting the browser between files) |
| `headed`    | Run with a visible window, holding the display lock. Default `false`                                                                        |
| `env`       | Harness environment. A value starting `{artifacts}` names a path in the lane's output directory                                             |
| `uploadDir` | Give the harness a `MOZ_UPLOAD_DIR` in the lane's output directory. Default `false`                                                         |
| `machArgs`  | `--setpref=<name>=<value>` arguments whose value names no path; `marionette.*` prefs are refused                                            |
| `validate`  | `{ "command": [...] }`, run after the harness exits clean; a nonzero exit reads red                                                         |

`env` refuses names FireForge, the build or the toolchain owns: anything starting `FIREFORGE_`, `MOZ_`, `MACH`, `NODE_`, `GIT_`, `PYTHON`, `CARGO`, `RUST`, `LD_`, `DYLD_`, `XDG_`, `LC_` and similar, and names such as `PATH`, `HOME`, `TMPDIR`, `DISPLAY`, `CC`, `CFLAGS`. A value is one line of at most 4096 characters, and a path in it must stay inside the workspace or start with `{artifacts}`.

`validate.command` is an argument vector run from the project root: `node <script> [arguments]`, or a committed script by its path. `{artifacts}` expands to the lane's output directory, and no argument may name a path outside the workspace. The validator's environment names the project directory (`FIREFORGE_PROJECT_ROOT`) and the engine of the workspace the gate runs in (`FIREFORGE_ENGINE`). With `uploadDir`, what the harness uploaded is in `{artifacts}/upload`.

### `stress`

A lane with `repeat`: it runs that many times, and every repetition must pass.

### `controls`

A negative control proves a test catches what it claims to ([testing.md](testing.md#negative-controls)): `diff` is a committed diff (project-relative) holding a mutation, `test` the engine-relative test that must catch it, and `assertions` the labels of the reds it must produce, every one and no other. A control that goes red anywhere else fails its entry as `wrong-red`, naming the expected assertions and the ones seen.

A control is judged the same however wide the change around it is and whether or not the change touches the file its diff mutates: it needs only that the diff applies to the engine the workspace holds.

Several controls in one run share one workspace and run in turn: each applies its mutation, builds what that mutation needs, runs its test, and restores. A control that is red does not stop the next. The tests of the controls run unmutated before the first mutation, and the build of the restored engine is left to the next mutation's build, so a run of _n_ controls whose mutations need a build costs _n_ builds plus one for the engine put back, not two each.

### `runs`

A smoke start of the built browser, as `fireforge run --smoke-exit` does it.

| Key                | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `id`               | Run ID                                                                     |
| `smokeExit`        | Seconds the console is watched before the browser is ended                 |
| `headless`         | Start without a window. Default `false`, which holds the display lock      |
| `args`             | Arguments for the browser                                                  |
| `consoleAllowFile` | Committed file of console line patterns the smoke start accepts            |
| `validate`         | As on a lane; judges what the run wrote, such as `{artifacts}/console.txt` |

The start passes only when the browser printed a line of its own after mach logged starting it: output before that line, and Python warnings and tracebacks, are the launcher's and show nothing about the browser. A browser that exits cleanly and early passes when it printed such a line.

### `acceptance`

Decisions only a person can make, such as a visual check. `reason` says what is decided; `evidence` lists the declared entries (`lane:<id>`, `stress:<id>`, `control:<id>`, `run:<id>`) whose outputs the person looks at.

## What a gate run does

`fireforge gate` decides, in this order:

1. **Clean tree.** There must be a commit (`gate-no-commit`, exit 4), and the working tree must equal it (`gate-dirty-tree`, exit 1). Untracked files that are not ignored count.
2. **Already verified.** When `refs/fireforge/verified` is at HEAD, the result is `verified` at once.
3. **Fast-forward only.** When the verified commit is not an ancestor of HEAD, the gate refuses (`gate-not-fast-forward`, exit 4). `--allow-rewrite` moves the ref to a commit that does not descend from it.
4. **Recorded pass.** When this checkout recorded a passing full run for this commit, with the same tree, the same FireForge version and the same `gate` declaration, that result stands and nothing runs again. The declaration is compared with the contents of the files it names (each control's diff, each `consoleAllowFile`), so a file git ignores cannot change under a recorded pass.
5. **Documents only.** When every path changed since the verified commit matches `gate.documents`, only `check` runs.
6. **Controls only.** When what changed since the verified commit is documents, the diff files of declared controls, and `fireforge.json` differing only inside `gate.controls`, the product code, the lanes and every control that did not change stand as the verified commit proved them. The gate leases a workspace and runs `check`, the build, and the controls whose diff file or declaration changed or that a commit added. A control diff that the build reads (a file under the source root, `components/`, `patches/` or `configs/`) or that another declared entry names, an acceptance whose `evidence` names a control that would run again, and anything else in the change take the full run instead. When no control changed, `check` alone runs, as for documents.
7. **Full run.** Otherwise the gate leases a workspace and runs, in order: `check`, component deployment and the build, then every lane, stress run, control and smoke start. A red entry does not stop the ones after it, so one run reports everything. After a red build the rest is skipped. The result is recorded for the commit.

Every run that did work ends the same way: HEAD and the working tree must be unchanged (`gate-tree-moved`, exit 14), checked before any result is recorded or the ref moves. A controls-only run records no result for the commit, since it proves only what it ran; the commit stands through the ref, like a documents-only one.

One gate runs on a commit at a time in a checkout. A second gate on the same commit says it is waiting for a running gate of the same commit (`--wait-lock` bounds the wait), and then reads the result the first recorded, so it never deletes logs a running gate is writing and never starts the work twice. A gate of another commit whose hash shares the first two characters waits the same way.

Then:

- Anything red: the result is `failed`. Exit 5 when the build or a declared entry is red, exit 1 when only `check` is (`gate-check-failed`).
- An entry that could not judge the commit is `blocked`, not red: a lock it needed did not come free (`lock-timeout`, exit 15), or the engine changed while it ran (`gate-inconclusive`, exit 14). When every failed entry is blocked the gate exits with that code and its hint, as `test` does, instead of reading the commit as bad; run it again. A red entry beside a blocked one keeps exit 5.
- Everything passed, but declared acceptances are not recorded for this tree: the result is `pending`, exit 0, and the ref does not move. The next `gate` reuses the recorded pass. A documents-only or controls-only commit needs no acceptance.
- Everything passed and every acceptance is recorded: the ref moves to the commit by compare-and-swap against the value it had when the gate started. If another gate moved it meanwhile, the gate leaves it there (`gate-ref-moved`, exit 4). The result is `verified`.

A gate that exits 0 has not necessarily moved the ref: read `result=` on the verdict line ([machine-output.md](machine-output.md#gate)).

### A gate that outlives its session

A full gate takes as long as the build and every declared entry take. A session whose client has a time limit starts it detached with the shell's own tools, so the gate keeps running when the client is gone:

```sh
nohup npx fireforge gate --json > .fireforge/gate.out 2>&1 &
# or: setsid npx fireforge gate > .fireforge/gate.out 2>&1 &
```

Any session in the checkout then reads whether it is still running, without taking or disturbing a lock:

```sh
npx fireforge gate status --json
```

`running` lists each gate in the checkout with its `pid`, the time it `since` asked for its run slot, `commit`, whether that is HEAD (`onHead`), and the `entry` it is on (`id`, `position` of `total`, and when it started). A gate writes that progress to `progress.json` in its commit's directory; the file is advisory, and a gate whose progress could not be written still runs and judges. When `running` no longer lists the gate, its result is the recorded one: `result` in `gate status`, or the document and the `result=` key of the verdict line the gate wrote ([machine-output.md](machine-output.md#gate)). Exit 0 alone does not mean verified: a `pending` gate and a `feedback` run exit 0 too, and only `result=verified` says the ref is at the commit.

A gate that was started again on the commit waits for the running one and reads its recorded result; no waiter that greps text is needed, and none can start a duplicate.

### Resuming

```sh
npx fireforge gate --resume
```

A clean committed tree cannot change without a new commit, so a second gate on the same commit is a retry of entries that were red, blocked, or never reached. `--resume` takes the passes of the last full run of this commit instead of running those entries again, when this checkout holds that run for the same commit, tree and FireForge version, made under the same `gate` declaration (compared by a hash of the section and of the control diffs and console allow files it names). The run may have ended red or been killed: a gate records each entry's result in `progress.json` as the entry ends, and writes `result.json` at the end.

- `check` and the build always run again.
- Every entry that was red, blocked, skipped or never reached runs; so does an entry whose output directory is gone.
- Every entry that passed is not run again. It is marked `reused` in the report, on the verdict line (`reused=<ids>`) and in the JSON, with `ranAt`, when it originally ran. A reused entry may have been built in another pool workspace than the one the rest of this run uses; the tree was the same. Its logs and outputs stay under `.fireforge/gate/<commit>/`, which a resumed run does not clear.
- The result recorded at the end is an ordinary full result, so acceptances, `gate accept` evidence, the recorded pass and the move of the verified ref work as for any run; the reused entries keep their `reused` mark and `ranAt`.
- When anything does not match (no recorded run, another tree, another FireForge version, a changed declaration), the gate says why on stderr and in `resume.why`, and runs everything.

Without `--resume` a gate runs every entry. `--resume` has no effect on a commit that needs only part of the gate (documents or controls only), and it cannot be combined with `--lane`.

### Host load

An entry that ends red, blocked or interrupted carries a note on what the host was doing: the load average against the CPU count when the entry started and when it ended, and, when either was above the CPU count, the busiest process outside the gate's own process tree (name, PID and CPU use as `ps` reports it). The note is in the entry's line and in its `load` key. It is sampled with one bounded `ps` call, is absent on Windows or when the call fails, and never changes a verdict or an exit code. A gate interrupted mid-entry prints the same note, and `progress.json` keeps it.

### Feedback runs

```sh
npx fireforge gate --lane sidebar --lane run:startup
```

`--lane <id>` (an ID, or `kind:id`; repeat for several) is feedback only: it runs those entries, plus the build, on the working tree as it is, committed or not. It runs no `check`, records nothing, and never moves `refs/fireforge/verified`. The result is `feedback`.

`kind:*` selects every declared entry of a kind (`lane:*`, `stress:*`, `control:*`, `run:*`):

```sh
npx fireforge gate --lane 'control:*'
```

runs every declared control in one workspace, each in turn, and reports a verdict per control (`caught`, `missed`, `wrong-red`, `baseline-red`, `inconclusive`) whether or not an earlier one was red. A feedback run still writes the control record below.

## Accepting

```sh
npx fireforge gate accept visual --note "Compared captures at 2x with the design, all match"
```

`gate accept <id>` records who decided, when, and the note, against the tree of the checked-out commit. The working tree must be clean, the ID must be declared, and every entry named in its `evidence` must have passed in a gate run on this commit in this checkout (`gate-evidence-missing`, exit 1): run the gate, look at what it produced under `.fireforge/gate/<commit>/`, then accept. `--by <name>` names who decides; the default is git's `user.name`, else the login name.

Acceptances are stored as git refs, `refs/fireforge/accepted/<tree>`, shared by every worktree of the repository and bound to the tree, so a commit with the same tree keeps them. After the last acceptance, run `fireforge gate` again to move the ref.

## Status

```sh
npx fireforge gate status
```

Shows where `refs/fireforge/verified` is and how HEAD relates to it (`verified`, `ahead` by some commits, `diverged`, or `unverified`), whether the tree is clean, which gates are running in this checkout (PID, since when, and the entry each is on; [A gate that outlives its session](#a-gate-that-outlives-its-session)), what the gate recorded for HEAD in this checkout, which acceptances are recorded, which are pending, and which declared controls are owed a run.

## Controls owed

Every way a control runs (the full gate, a feedback run, and `fireforge test --control`) is written to `.fireforge/gate/controls.json` in the checkout. A run is recorded with the diff's path and content hash, the declared ID when it ran as one, the tests and expected labels, what it ran against (the commit and tree when the working tree was clean, and the engine state the test runner judges by), the outcome, and the assertions that went red, including unexpected ones. The file keeps the newest runs of each control and is bounded. A file that cannot be read reads as empty.

`gate status` and the summary of every gate run list the declared controls with no standing proof, each with why:

| Reason         | Meaning                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `never-run`    | No run is recorded for it in this checkout                                                                                         |
| `changed`      | Its diff, or its declaration (the test or the assertions), changed since it last ran                                               |
| `tree-changed` | The tree changed since it was last seen caught, by more than documents and other controls; or it was caught on an uncommitted tree |
| `missed`       | Its last run stayed green with the mutation applied                                                                                |
| `wrong-red`    | Its last run was red beyond the expected assertions, or not at exactly the expected ones                                           |
| `not-caught`   | Its last run ended `baseline-red` or `inconclusive`                                                                                |

An ad hoc `fireforge test --control` run counts for the declared control whose diff, test and assertions it repeats exactly. The list informs: it never changes an exit code or keeps the ref from moving. `fireforge gate --lane 'control:*'` runs the owed controls.

## Where results live

- `.fireforge/gate/<commit>/` in the checkout: `result.json`, `progress.json` while a run is working or after one was killed, and one directory per entry: `lane-<id>/output.log`, `lane-<id>/results.json`, `lane-<id>/upload/`, `run-<id>/console.txt`. The newest five runs are kept; a run another gate is still writing is never removed. A feedback run writes `.fireforge/gate/feedback/`, or `feedback-1/` to `feedback-3/` while another feedback run holds it.
- `.fireforge/gate/controls.json`: the control record ([Controls owed](#controls-owed)).
- `refs/fireforge/verified`: the last commit that passed.
- `refs/fireforge/accepted/<tree>`: the recorded acceptances.

Push the refs if other machines should see them:

```sh
git push origin refs/fireforge/verified 'refs/fireforge/accepted/*:refs/fireforge/accepted/*'
```

## A pre-push hook

This hook refuses to push a branch whose tree is not the verified tree. Save it as `.git/hooks/pre-push` (or `.husky/pre-push`) and make it executable.

```sh
#!/bin/sh
# Refuse a push whose tree FireForge has not verified.
verified=$(git rev-parse -q --verify 'refs/fireforge/verified^{tree}') || {
  echo "pre-push: nothing is verified yet; run: npx fireforge gate" >&2
  exit 1
}
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac # a deletion pushes nothing
  case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac
  if [ "$(git rev-parse "$local_sha^{tree}")" != "$verified" ]; then
    echo "pre-push: $local_ref is not the verified tree; run: npx fireforge gate" >&2
    exit 1
  fi
done
exit 0
```

It compares trees, not commits, so rewording the verified commit's message does not invalidate it.
