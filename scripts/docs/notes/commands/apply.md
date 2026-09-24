`--skip-simulation` is explicitly refused. `--resume` accepts only a verified
transaction boundary. `--skip-gates` does not bypass validation, journal,
scope, or audit proofs; normal operation should run the configured gates.
Do not run standalone `apply` immediately before `apply --commit`: the committed
invocation already simulates, and Monocarve intentionally does not reuse stale
simulation evidence. Use the standalone form only when its result must be
reviewed before deciding whether to land.
Refreshing is a separate compile step to a new path. It never approves or
applies the refreshed plan in the same invocation. Source, closure, target,
config, or execution-policy drift remains a hard refusal.

After journal replay and generated-artifact regeneration, simulation checks a
repository-wide structured postcondition: every registered package has no
dependency duplicated across manifest sections, every `workspace:` dependency
names a registered package, and every package manifest agrees with its
lockfile importer. A committing apply repeats the same audit against the real
checkout after its commits; failure enters normal transaction rollback.
On failure, the result keeps the compatible bounded `output` excerpt and adds a
structured `failedGate` (`tier`, `command`, `exitCode`, `outputHead`,
`outputTail`, and `logPath`). The full stdout/stderr log is stored beside the
retained failed worktree under `transaction.worktreeRoot`, not in the gated checkout.
`gateRetry` supplies its exact cwd and configured command. If persistence fails, `logWriteFailure` records
that secondary error without hiding the gate failure. Logs are not secret-
redacted; configure gate commands to avoid printing credentials. The generic
`transaction.gateRetries` policy defaults to zero, is capped at three, and
records every exit code/output excerpt in `attempts`; it never silently drops a
failed attempt that later passes.
