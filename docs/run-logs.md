<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Run logs (internal)

`fireforge test` and `fireforge build` write their own complete output to
`.fireforge/logs/<command>-<timestamp>.log` as they stream. The module is
`src/core/run-log.ts`.

## Why the tool holds the log, not the operator

A run's diagnosis used to exist in exactly one place: the terminal. The
convenient thing to do when output is long is
`fireforge test … 2>&1 | tail -40`, which keeps the summary, discards the
`TEST-UNEXPECTED-FAIL` lines that say what broke, and launders the exit code
as well. Nothing else held the output: `runMachCapture` keeps a 2 MB
in-memory tail that dies with the process, and the shard retry loop discards
earlier attempts outright.

The operator rule ("never pipe a run") was written down three times
downstream and broken after each writing. That is a sign it is not an
operator problem. The tool is the only party that can make the log survive
the mistake.

## The contract

- **Complete output, never the echo filter's collapsed form.** The artifact
  exists so that whoever is diagnosing the run can re-read it. Shortening it
  would bring back the loss it prevents. The one transformation applied is
  the secret-masking pass below, which changes values but never line
  structure.
- **Secret-shaped values are masked in the file, and only in the file.** The
  terminal already showed every byte to the operator who ran the command. The
  file is retained twenty deep and gets attached to bug reports, so it gets a
  narrow redaction pass (`src/core/run-log-redact.ts`), applied per line
  before the write. A line split across two chunks is held until its
  terminator arrives (`\n`, or a lone `\r` from progress-bar repaints), or
  until it exceeds 1 MiB, or until the log is closed. What gets redacted:
  - The value of an env-style assignment `KEY=value` whose `KEY` matches
    `/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH)/i`. The value up to the
    next whitespace, or a whole quoted string, is written as
    `KEY=<redacted>`. The `--password=x` and `-DAUTH_TOKEN=x` spellings that
    mach and configure echo from their argv have the same shape and are
    masked too.
  - The credential of an `Authorization:` header. `Bearer`, `Basic` and
    `Token` keep the scheme word. Any other value is masked whole.

  Nothing else is masked. A bare token in a URL, a space-separated
  `--password foo` argument, a JSON `"token": "…"` field, or a cookie all
  pass through unchanged. The pass is a seatbelt against the common
  accidental leak (mach echoing its environment), not a guarantee that a log
  is free of secrets. Review a log before sharing it.

- **Opened before any preflight**, so a refusal is logged too. Those are
  exactly the runs whose only output a `tail` throws away.
- **Retained 20 deep per command kind.** Per kind, so that a busy `test` loop
  cannot evict the `build` log an operator needs to read beside it. Pruning
  runs before the new file is opened, and orders by the timestamp in the
  filename rather than by stat-ing every entry.
- **Timestamps are filesystem-safe.** They use the ISO form with `:` and `.`
  replaced by `-`, which Windows accepts and which still sorts
  chronologically.
- **Best-effort throughout.** A log that cannot be opened, written or pruned
  degrades to no log, because a run must never fail over a diagnostic.
  `openRunLog` returns `undefined` on failure, a stream error after opening
  latches `broken` and drops every later write, and pruning failures are
  logged verbosely only. The entry point's SIGINT/SIGTERM path closes the
  active log, also best-effort, before exiting, so the held partial line of a
  killed run reaches disk.

## Preflight refusals

`fireforge test` opens its run log before any preflight, so a refusal is
logged too. Those are exactly the runs whose only output a `tail` throws
away. The refusal's own explanatory text is written into the log, and to
stdout, before the verdict line seals stdout.

Both halves matter. The verdict seal routes everything the CLI error boundary
renders afterwards to stderr, so a run captured with `> file` used to keep
`FIREFORGE-VERDICT: FAIL reason=preflight` and nothing else. That rendering
also happens after the run log is closed, so the artifact the verdict's own
`log=` key pointed at held only the pre-test build. Writing before the seal
fixes both without giving up the contract: the reason lands on both channels,
and the verdict is still the run's last stdout line.

## Where the path is announced

`test` publishes it as an additive `log=<path>` key on the
`FIREFORGE-VERDICT:` line. That is forced rather than chosen: the verdict has
to stay the run's last stdout write (see
[`machine-output.md`](machine-output.md)), so a separate announcement after
it would break the contract, and one before it is the first thing a `tail`
cuts.

`build` prints no verdict line, so it announces the path directly
(`Full build output: <path>`).

## Where the tee sits

At the two mach capture funnels in `src/core/mach.ts`, not at the commands.
That covers every dispatch: the three test dispatchers, `package`, and the
stdio-inheriting path `mach build` uses, which rides the collectors' existing
`mirror` hook rather than growing a second one. A new dispatcher added at the
funnels is logged automatically, and one added beside them is not, which is
the reason to keep going through them.
