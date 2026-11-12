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

### `acceptance`

Decisions only a person can make, such as a visual check. `reason` says what is decided; `evidence` lists the declared entries (`lane:<id>`, `stress:<id>`, `control:<id>`, `run:<id>`) whose outputs the person looks at.

## What a gate run does

`fireforge gate` decides, in this order:

1. **Clean tree.** There must be a commit (`gate-no-commit`, exit 4), and the working tree must equal it (`gate-dirty-tree`, exit 1). Untracked files that are not ignored count.
2. **Already verified.** When `refs/fireforge/verified` is at HEAD, the result is `verified` at once.
3. **Fast-forward only.** When the verified commit is not an ancestor of HEAD, the gate refuses (`gate-not-fast-forward`, exit 4). `--allow-rewrite` moves the ref to a commit that does not descend from it.
4. **Recorded pass.** When this checkout recorded a passing full run for this commit, with the same tree and the same FireForge version, that result stands and nothing runs again.
5. **Documents only.** When every path changed since the verified commit matches `gate.documents`, only `check` runs.
6. **Full run.** Otherwise the gate leases a workspace and runs, in order: `check`, component deployment and the build, then every lane, stress run, control and smoke start. A red entry does not stop the ones after it, so one run reports everything. After a red build the rest is skipped. When the run ends, HEAD and the working tree must be unchanged (`gate-tree-moved`, exit 14). The result is recorded for the commit.

Then:

- Anything red: the result is `failed`. Exit 5 when the build or a declared entry is red, exit 1 when only `check` is (`gate-check-failed`).
- Everything passed, but declared acceptances are not recorded for this tree: the result is `pending`, exit 0, and the ref does not move. The next `gate` reuses the recorded pass. A documents-only commit needs no acceptance.
- Everything passed and every acceptance is recorded: the ref moves to the commit by compare-and-swap against the value it had when the gate started. If another gate moved it meanwhile, the gate leaves it there (`gate-ref-moved`, exit 4). The result is `verified`.

A gate that exits 0 has not necessarily moved the ref: read `result=` on the verdict line ([machine-output.md](machine-output.md#gate)).

### Feedback runs

```sh
npx fireforge gate --lane sidebar --lane run:startup
```

`--lane <id>` (an ID, or `kind:id`; repeat for several) is feedback only: it runs those entries, plus the build, on the working tree as it is, committed or not. It runs no `check`, records nothing, and never moves `refs/fireforge/verified`. The result is `feedback`.

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

Shows where `refs/fireforge/verified` is and how HEAD relates to it (`verified`, `ahead` by some commits, `diverged`, or `unverified`), whether the tree is clean, what the gate recorded for HEAD in this checkout, which acceptances are recorded, and which are pending.

## Where results live

- `.fireforge/gate/<commit>/` in the checkout: `result.json` and one directory per entry: `lane-<id>/output.log`, `lane-<id>/results.json`, `lane-<id>/upload/`, `run-<id>/console.txt`. The newest five runs are kept. A feedback run writes `.fireforge/gate/feedback/`.
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
