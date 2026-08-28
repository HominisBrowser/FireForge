<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Run logs (internal)

`fireforge test` and `fireforge build` write their own complete output to
`.fireforge/logs/<command>-<timestamp>.log` as they stream. The module is
`src/core/run-log.ts`.

## Why the tool holds the log, not the operator

A run's diagnosis used to exist in exactly one place: the terminal. The
ergonomic default when output is long — `fireforge test … 2>&1 | tail -40` —
keeps the summary and discards the `TEST-UNEXPECTED-FAIL` lines that say WHAT
broke, and it launders the exit code besides. Nothing else held the output:
`runMachCapture` keeps a 2 MB in-memory tail that dies with the process, and
the shard retry loop discards earlier attempts outright.

The operator rule ("never pipe a run") was written down three times downstream
and broken after each writing. That is the tell that it is not an operator
problem — the tool is the only party that can make the log survive the
mistake.

## The contract

- **Raw bytes, never the echo filter's collapsed form.** The artifact exists
  to be re-read by whoever is diagnosing the run; shortening it would
  reintroduce the loss it prevents.
- **Opened before any preflight**, so a refusal is logged too. Those are
  exactly the runs whose only output a `tail` throws away.
- **Retained 20 deep per command kind.** Per-kind, so a busy `test` loop
  cannot evict the `build` log an operator needs to read beside it. Pruning
  runs before the new file is opened, and orders by the filename's
  timestamp rather than by stat-ing every entry.
- **Timestamps are filesystem-safe**: the ISO form with `:` and `.` replaced
  by `-`, which Windows accepts and which still sorts chronologically.
- **Best-effort throughout.** A log that cannot be opened, written or pruned
  degrades to no log. A run must never fail over a diagnostic, so `openRunLog`
  returns `undefined` on failure, a post-open stream error latches `broken`
  and drops every later write, and pruning failures are logged verbosely
  only.

## Where the path is announced

`test` publishes it as an additive `log=<path>` key on the
`FIREFORGE-VERDICT:` line. That is forced, not chosen: the verdict must stay
the run's LAST stdout write ([`machine-output.md`](machine-output.md)), so a
separate announcement after it would break the contract, and one before it is
the first thing a `tail` cuts.

`build` prints no verdict line, so it announces the path directly
(`Full build output: <path>`).

## Where the tee sits

At the two mach capture funnels in `src/core/mach.ts`, not at the commands.
That covers every dispatch: the three test dispatchers, `package`, and the
stdio-inheriting path `mach build` uses — which rides the collectors' existing
`mirror` hook rather than growing a second one. A new dispatcher added at the
funnels is logged by construction; one added beside them is not, which is the
reason to keep going through them.
