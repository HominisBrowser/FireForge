<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Run logs

`fireforge test` and `fireforge build` write their complete output to `.fireforge/logs/<command>-<timestamp>.log` as they stream. A piped run (`fireforge test … 2>&1 | tail -40`) keeps the summary and discards the lines that say what broke, so the tool keeps the log for you.

## Contract

- **Complete output.** The file holds every line the run printed, never the shortened echo.
- **Secret-shaped values are masked in the file only.** The terminal already showed them to you; the file is retained and gets attached to bug reports. Masked: the value of `KEY=value` when `KEY` matches `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY` or `AUTH` (also the `--password=x` and `-DAUTH_TOKEN=x` spellings), written as `KEY=<redacted>`; and the credential of an `Authorization:` header (the scheme word of `Bearer`, `Basic` and `Token` stays). Nothing else is masked: a token in a URL, a space-separated `--password foo`, a JSON `"token"` field or a cookie pass through. Review a log before sharing it.
- **Opened before any preflight**, so a refused run is logged too, including the refusal's text.
- **Retained 20 deep per command kind**, so a busy `test` loop cannot evict the `build` log you read beside it. Timestamps are filesystem-safe and sort chronologically.
- **Best-effort.** A log that cannot be opened, written or pruned degrades to no log; a run never fails over a diagnostic. An interrupt closes the log first, so a killed run keeps what it wrote.

## Keeping a log past retention

Retention is shared by every session on the checkout, so a log a verdict names can be pruned within the hour on a busy checkout. `--keep-log <path>` (on `test` and `build`) also writes the run's log to a path you choose, outside `.fireforge/logs/` and never pruned. `FIREFORGE_LOG_KEEP=<path>` does the same for every run in a session; the flag wins. A value ending in `/` or naming an existing directory receives the log under its own file name, so a session directory collects one file per run. Any other value is the file itself. Relative values resolve against the working directory. The copy is written live through the same masking; `log=` still names the primary.

## Where the path is announced

`test` publishes it as `log=<path>` on the `FIREFORGE-VERDICT:` line (see [machine-output.md](machine-output.md)). `build` prints `Full build output: <path>`.
