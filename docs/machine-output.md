<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Machine-readable output contract (internal)

The `--json` surface is a contract with scripted consumers. Before 0.44.0 it
was four unrelated shapes: `status --json` and `tree list --json` shared a
`schemaVersion: 1` envelope but disagreed on failure, `test` emitted a
`FIREFORGE-VERDICT:` line, and `lint --per-patch --report` wrote a versioned
file nothing ever reads back. This file is the single statement of what a
`--json` command must do, so the next one added does not invent a fifth.

## The rules

1. **Success writes exactly one JSON document to stdout**, with
   `schemaVersion` as its first key.
2. **Failure writes exactly one error document to stdout**, of the shape
   `{ "schemaVersion": 1, "error": "<human message>", "code": "<tag>" }`,
   and then exits non-zero. The `error` text is the same sentence the
   non-JSON mode would print; `code` is a stable machine-readable tag
   (`engine-missing`, `engine-not-git`, `tree-list-failed`, …) that consumers
   may branch on.
3. **Machine mode is engaged before any output.** `setMachineOutputMode(true)`
   must run before the first write, so every diagnostic — including one
   rendered later by `withErrorHandling` — routes to stderr and cannot
   interleave with the payload.
4. **stdout carries nothing else.** No banners, no progress, no warnings.
   `logger.ts` enforces this through a single `routeToStderr()` gate that all
   its helpers consult, including `spinner()`, `note()` and `intro`/`outro`.

## Implementation

Use `emitMachineError` from `src/utils/machine-output.ts` for rule 2. It
writes the envelope and throws `CommandError`, which the CLI boundary treats
as already-rendered — so the boundary adds no second rendering on stderr.

```ts
if (options.json === true) {
  setMachineOutputMode(true);
  try {
    const payload = await collect();
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION, ...payload }, null, 2)}\n`
    );
  } catch (error: unknown) {
    emitMachineError('collect-failed', toError(error).message);
  } finally {
    setMachineOutputMode(false);
  }
  return;
}
```

## Current surfaces

| Surface                            | Shape                                                 | Notes                                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status --json`                    | `{ schemaVersion: 1, … }`                             | Error envelope on three engine preconditions                                                                                                                                                                                       |
| `tree list --json`                 | `{ schemaVersion: 1, trees }`                         | Error envelope added in 0.44.0                                                                                                                                                                                                     |
| `test` verdict line                | `FIREFORGE-VERDICT: PASS\|FAIL reason=… [log=<path>]` | Not JSON. A single final stdout line, sealed by `setStdoutSealed` so nothing can displace it. `log=` names the run's own complete output under `.fireforge/logs/`, so a piped or truncated run still leaves a re-readable artifact |
| `lint --per-patch --report <path>` | `{ schemaVersion: 1, … }`                             | Written to a file, never read back by FireForge                                                                                                                                                                                    |
| `status --raw`                     | `git status --porcelain` lines                        | Not JSON, but a machine surface: it engages the same stdout discipline, so rules 3 and 4 apply and rules 1 and 2 do not. A clean tree prints nothing                                                                               |
| `build` log announcement           | `Full build output: <path>`                           | Not JSON. `build` prints no verdict line, so it names its run log directly on the way out                                                                                                                                          |

`--raw` is why `cli.ts` reads `process.argv` for `--json` **or** `--raw`
before dispatching: rule 3 is about who owns stdout, and that question is
settled the same way for a porcelain stream as for a JSON document.

`doctor` and `verify` have no `--json` mode. `doctor` already computes a
serializable `DoctorCheck[]`, so adding one is cheap if a consumer asks —
follow the rules above rather than inventing a shape.

The run logs behind `log=` are specified in [`run-logs.md`](run-logs.md).

## Versioning

`schemaVersion` is `MACHINE_OUTPUT_SCHEMA_VERSION` in
`src/utils/machine-output.ts`. Additive changes (a new key) do not bump it.
Removing or retyping a key does, and needs a note in the changelog naming
what moved.

## `test` verdict reasons

`FIREFORGE-VERDICT: FAIL reason=<reason>` uses a closed set
(`FireforgeVerdictReason`, `src/commands/test-verdict.ts`):

| Reason          | Meaning                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crash`         | The harness or the browser died; no trustworthy suite result.                                                                                                                                                        |
| `no-tests`      | The run dispatched but nothing ran.                                                                                                                                                                                  |
| `test-failures` | The suite ran and reported unexpected results.                                                                                                                                                                       |
| `preflight`     | The run was refused before the harness was reached.                                                                                                                                                                  |
| `inconclusive`  | A result exists but `engine/` moved under it, so it was discarded.                                                                                                                                                   |
| `lock-timeout`  | The run never started: the engine session lock stayed contended.                                                                                                                                                     |
| `killed`        | A signal terminated the run. Written from the signal handler so a log tail is always self-describing — a killed run must never be silent, or "killed", "still running" and "never started" become indistinguishable. |
