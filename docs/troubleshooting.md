# Troubleshooting

Monocarve refuses instead of guessing, so most problems show up as a refusal
with a reason. Refusals print as `monocarve: <message>`, often followed by a
`hint:` line with the next step. The messages quoted below are the ones the
code emits. `<…>` marks a placeholder. For the meaning of each exit code, see
[Errors and exit codes](errors-and-exit-codes.md). In brief: `0` success, `1`
refusal or negative verdict, `2` degraded assessment, `3` a not-yet-ported
seam, `64` malformed invocation, `70` internal defect (please report it).

## No config found

```text
monocarve: no config found in <cwd> or any parent directory (looked for monocarve.config.ts, monocarve.config.mts, monocarve.config.js, monocarve.config.mjs, monocarve.config.json)
hint: create monocarve.config.ts exporting `defineConfig({ ... })` from "monocarve/config" (or pass --config <path>), then run `monocarve config-doctor`
```

Discovery walks up from the current directory, or from `--cwd`. Run the
command inside the workspace or pass `--config <path>`. `config not found: <path>` means the explicit `--config` path does not exist.

Other config errors:

- `invalid config at <path>:` is followed by one line per failing field path.
  A field that names an unimplemented adapter reads
  `npm is not supported yet; supported package managers: pnpm, bun` (the task
  runners are `moon, none`).
- `<path> has no default export`: the config must `export default`.
- `could not load the config: Cannot find package 'monocarve' imported from <config>`: the config imports `monocarve/config` but the package cannot be
  resolved from the workspace. Install or link it (see
  [the README](../README.md#install)). The standalone `artifacts/monocarve`
  executable currently cannot resolve that import at all. Use the package
  binary (`bunx monocarve`), or use a JSON config or a TypeScript config with
  no imports. `assess` and its replay and batch forms are unaffected: they
  serve the facade from the running tool (see below).

## Unknown option or command (exit 64)

```text
monocarve: unknown option --bogus for `monocarve plan`
hint: run `monocarve plan --help` for its options

usage: monocarve plan --candidate <id> ...
```

Every flag is validated before any config loads, so a typo never reaches your
workspace. Global options (`--config`, `--cwd`, `--graph`, `--no-cache`,
`--json`) work before or after the command. Command options must come after
the command. Where possible, the hint suggests the closest flag
(`did you mean --…?`). `--allow-dirty` is refused as a usage error. See the
next section.

## Dirty working tree

```text
monocarve: refusing to plan from a dirty working tree: <paths>
commit or stash these paths; transaction.allowDirtyPaths may name only unrelated paths (plan inputs, outputs, generated artifacts, and baseline-sensitive files are never allowed).
```

```text
monocarve: apply requires a clean worktree: <paths>
```

Commit or stash the listed paths. `transaction.allowDirtyPaths` in the config
can list paths that are genuinely unrelated. It never overrides a plan input,
output, consumer, or generated artifact, and there is no command-line flag
that does. Related refusals include
`approval requires only an unstaged manifest; dirty paths: <paths>`,
`preparation apply requires a clean worktree: <paths>`, and
`cannot refresh from a dirty workspace; …`.

If the dirty paths are left over from an interrupted apply, don't clean them
by hand. See [Interrupted apply](#interrupted-apply).

## Stale plan: config digest or compiler identity mismatch

```text
monocarve: plan <id> failed validation with 1 error(s):
  [compiler-integrity] plan compiler identity does not match this compiler
```

A plan validates only under the conditions that produced it (see
[Plan identity](concepts.md#plan-identity)).

- **`[compiler-integrity]`**: the Monocarve build changed. When you run from
  source (`bun run cli`, or a linked checkout), the identity is a hash of the
  checkout's `src/**/*.ts`, so a `git pull`, a rebuild, or a local edit
  invalidates existing plans. Pin one build for the whole
  plan→approve→apply→audit loop. If the build did change, run
  `refresh --plan <path>` to preview and then
  `refresh --plan <path> --out <new-path> --write`, and approve the new
  manifest. `monocarve --version --verbose` shows the identity of the running
  build.
- **`[config-digest]` or `[policy-digest]`**: the effective config or the
  gate, commit, or scaffold policy changed. `refresh` refuses this with
  `cannot refresh plan: configuration provenance changed; compile a new plan`,
  so compile a new plan.
- **`HEAD` moved.** `HEAD must contain exactly the approved manifest over the baseline; expected manifest-only approval: git add -- <path> && git commit -m "<subject>"`. A plan applies only at its own baseline plus its approval
  commit. If `HEAD` moved for unrelated reasons, `refresh` the plan. The
  related messages `the plan manifest must be committed before apply`,
  `the approved manifest commit must be directly atop the plan baseline`, and
  `the approved manifest commit subject is "<x>"; expected "<y>"` each name
  the exact fix.
- `cannot refresh plan <id>: candidate no longer resolves; compile a new plan`:
  the source closure changed shape. Choose a candidate again from
  `portfolio`.

Never edit a manifest by hand. Recompile it.

## Gate failures and kept worktrees

A failing gate stops the simulation before your checkout is touched. The JSON
result contains:

- `failedGate`: `tier`, `command`, `exitCode`, `outputHead`, `outputTail`, and
  `logPath` (the full stdout and stderr, written beside the retained
  worktree),
- `worktreePath`: the simulation worktree, which is **always kept** after a
  gate failure,
- `gateRetry`: `{ cwd, command }`, so you can rerun the exact command in that
  worktree,
- `logWriteFailure`, only if the log could not be written. The gate result
  still stands.

Reproduce the failure with `cd <gateRetry.cwd> && <gateRetry.command>`. Fix
the cause in your real checkout (code, config, or gate), and compile a new
plan if any baseline-sensitive input changed. If a gate _writes_ files, such
as a baseline or registry, run `inspect-gates --plan <path>` to find out which
paths each gate changes before you declare them in `generatedArtifacts` or a
preparer. `transaction.gateRetries` (0 to 3) retries a flaky gate and keeps
every attempt as evidence. Other failures keep the worktree only when
`transaction.cleanup` is `false`. Remove old worktrees with
`prune-worktrees` (default `--older-than 1h`, or `--all`).

`refusing to commit on the guarded branch <branch>; apply from a feature branch instead`: `guardedBranches` blocks committing applies on that branch. Keep your
approval commit, move to a feature branch, and run `verify` again.

## Interrupted apply

If a committing apply is interrupted by Ctrl-C (`SIGINT`) or `SIGTERM`, it
rolls back in-process, releases its lock, and exits with 130 or 143. It
prints `apply interrupted by <signal>; <outcome>`. If the outcome says the
restore failed or the transaction was kept, the lock stays held: run
`apply-status`, then `apply-recover`, as below. A failed rollback after an
ordinary apply error (`…; transaction kept for recovery: run monocarve apply-recover --plan "<path>"`) works the same way.

After `SIGKILL`, a closed terminal, a crash, or a shell timeout, the next apply
refuses:

```text
monocarve: apply transaction <planId> is <phase> under process <pid>; run monocarve apply-status, then monocarve apply-recover --plan "<path>" after confirming the owner stopped
```

When the owner stopped on its own after a failed restore, the message reads
`apply transaction <planId> stopped at phase <phase> without restoring the checkout and awaits recovery; …`.
`apply-status` then shows `"released": true` and `ownerAlive: false`, and
`apply-recover` does not wait for that process to exit.

1. Run `monocarve apply-status`. It is read-only and shows the plan, phase,
   owner PID, and the recovery command.
2. Make sure the owner is really gone. `apply-recover` refuses with
   `apply owner process <pid> is still running; recovery would race it` or
   `… cannot be proven stopped …`.
3. Run `monocarve apply-recover --plan <path>`. If the phase was `applying`, it
   restores `HEAD`, the index, and every journal path from the durable
   checkpoint and verifies them. It then prints the exact `apply` command to
   run, with `--resume` only if the move commit had already landed.

`apply-recover` also refuses in these cases:

- `HEAD moved to <sha> since the interrupted apply checkpointed <sha>; refusing to reset it — inspect git log and restore manually`. Commits made after the
  interruption are never reset.
- `checkout is on <x>, but the interrupted apply ran on <y>; switch back before recovering`.
- `the interrupted apply ran in <dir>; run monocarve apply-recover from that checkout`.
- `active transaction belongs to plan <a>, not <b>`. Pass the plan named in
  the message.
- `apply-recover could not restore the interrupted apply: …; transaction files kept for retry`. Resolve the reported paths and run it again.
- `refusing to restore the interrupted apply: <n> path(s) changed after it stopped and would be overwritten: <path> (working tree), <path> (staged), …`.
  Something other than the apply changed those paths or staged those index
  entries after the interruption. Save or commit that work elsewhere and run
  `apply-recover` again, or add `--discard-changes` to overwrite it with the
  pre-apply state. The result's `restored.discarded` lists what was overwritten.

A new apply also refuses while an earlier transaction is unrecovered, even
when its lock is gone:

- `apply transaction <planId> … ; it was never recovered (its lock is gone, its state remains); run monocarve apply-status, then monocarve apply-recover --plan "<path>"`.
- `an apply checkpoint from an unrecovered transaction exists at <path>; …`.
  `apply-status` reports it as `orphanedCheckpoint`, and
  `apply-recover --plan <path>` restores it. If that apply is known to have
  completed, inspect the file and delete it instead.

Don't reset the branch while an owner is alive, and don't stage part of a
journal by hand.

## Corrupt apply lock

```text
monocarve: the apply lock at <git-common-dir>/monocarve-apply.lock is unreadable or corrupt, so its owner cannot be identified; after confirming no monocarve apply is running, run monocarve apply-recover --plan "<path>" --force-corrupt-lock
```

First confirm that no Monocarve process is running against this repository.
Then run the command shown. It moves the unreadable lock and state files aside
and restores this plan's checkpoint if there is one. The flag is refused when
the lock is readable
(`--force-corrupt-lock refused: the apply lock at <path> is readable; run monocarve apply-recover without it`) or missing.

## `git worktree add` is blocked

```text
monocarve: git -c core.hooksPath=/dev/null worktree add --detach <scratch>/worktrees/<planId>-<suffix> <baseline> failed in <repo>: Command failed: …
```

Every simulation needs a real `git worktree add`. Some hosts install a `git`
wrapper that blocks worktree creation to route it through another tool. If
you see this message with no other git error, check `command -v git` and the
wrapper's policy. If the wrapper provides a deliberate override, set it for
the Monocarve run, for example `ALLOW_GIT_WORKTREE_ADD=1 bunx monocarve apply …`. Other causes include a full disk or exhausted inodes under the scratch
root (see below), or a baseline commit missing from a shallow clone.

## Assessment refusals

The `assess` command, its `--replay` form, and batch declaration analysis run
a TypeScript or ESM config inside a sandbox. Every failure there is a
`ConfigError` whose message starts with `ASSESSMENT_CONFIG_UNBOUND:`:

| message suffix                                                       | fix                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `executable config requires bwrap`                                   | install bubblewrap (`/usr/bin/bwrap`)                                                |
| `executable config requires syscall read tracing`                    | install `strace` (`/usr/bin/strace`)                                                 |
| `isolated config execution failed: …`                                | usually unprivileged user namespaces are disabled; enable them, or use a JSON config |
| `dynamic config dependency in <file>`                                | a non-literal `import()`/`require` was found in the config or a file it imports      |
| `filesystem access in config dependency <file>`                      | the config imports `fs`; compute values statically                                   |
| `config attempted a read outside captured inputs: …`                 | the config reads something that is not a declared import; make it pure               |
| `config import escapes workspace and installed dependencies: <path>` | import only from the workspace or `node_modules`                                     |

Every value import is followed and captured. Type-only imports
(`import type …`, `export type … from`, and imports whose every binding is
`type`) are erased before execution, so they are neither followed nor
captured. The documented `import { defineConfig } from "monocarve/config"`
(or from `monocarve`) works: the sandbox serves that facade from the running
tool itself, never from the workspace's `node_modules/monocarve`, and records
its digest as `baseline.runtime.configFacade`. Inside the sandbox the facade
provides `defineConfig` only. A config that uses any other value from it
fails with `isolated config execution failed: … Export named '<name>' not
found`; compute that value without the import. Other commands load the same
`.ts` config normally.

Other assessment refusals:

- `EVIDENCE_DESTINATION_UNSAFE: evidence destination is not a confined relative path`. Pass `--evidence-dir` as a relative path inside the workspace.
  `… parent must be an existing regular directory`: create the parent first.
- `EVIDENCE_RECOVERY_REQUIRED`: an earlier publication was interrupted and left
  `.staging`, `.backup`, `.recovery.json`, or `.lock` state beside the
  destination. Inspect it and resolve it by hand. Monocarve does not steal
  locks or guess which bytes to keep.
- Exit 2 (`degraded`) is not an error. The bundle was published, and claims
  that depend on package data are marked unavailable.

For the full detail, see [Architecture assessment](assessment.md).

## Scratch root and `MONOCARVE_SCRATCH_ROOT`

Simulation worktrees and other disposable state live outside the repository,
by default in `~/.cache/monocarve/<checkout>-<hash12>/` (see
[Scratch root](concepts.md#scratch-root)).

- To put them on a different filesystem, for more space or to avoid `noexec`
  or quota limits, set `MONOCARVE_SCRATCH_ROOT=/abs/path` (used exactly as
  given, with no suffix) or `transaction.worktreeRoot` (worktrees only). A
  relative `MONOCARVE_SCRATCH_ROOT` is ignored.
- `Failed to create MONOCARVE_SCRATCH_ROOT directory at <root>: <reason>`: the
  explicit override is not writable. Point it at a writable absolute
  directory, or unset it. When there is no override and the cache directory
  cannot be created, Monocarve falls back to `$TMPDIR/monocarve/<checkout>-…`.
- Because an explicit `MONOCARVE_SCRATCH_ROOT` has no per-checkout suffix,
  every checkout that uses it shares one root, and `prune-worktrees --all`
  there affects all of them.

## Lockfile verification

`--verify-lockfile` runs the configured package manager in the simulation
worktree and compares its lockfile with the plan's splice. When you request
it, every way of not getting an answer is a failure:

- `lockfile verification needs <binary> on PATH, and it is not there: <command>`.
  Install the package manager, at the version your repository pins.
- `lockfile verification found no <lockfile> to compare`.
- `lockfile verification command failed (exit <n>): <command>`, followed by a
  tail of its output.
- A byte difference is reported as a bounded diff (`-` for the plan, `+` for
  the package manager), and missing resolutions are reported as
  `<lockfile>: <finding>`.

A difference means the splice is not what the package manager would write.
Don't commit the regenerated file over the plan. Report the difference, or
change the dependency layout and compile the plan again. A plan with no
`lockfile-importer` operation has nothing to verify.

## FAQ

**Can I skip simulation or gates?** You cannot skip simulation:
`--skip-simulation` is refused. `--skip-gates` skips only the repository gates
in the simulation. Validation, the journal, and the audit still run. It exists
for fast feasibility checks. The CLI does not currently stop you from
combining it with `--commit`, but a plan landed that way has not passed your
repository's checks. `transaction.simulateGates: false` is a workspace policy
choice with the same caveat.

**Can I use npm, yarn, nx, or turbo?** Not yet. Config validation rejects
them. The supported adapters are `pnpm` and `bun` for package management and
`moon` and `none` for task running.

**Does it run on Node?** No. The CLI and its TypeScript config loader require
Bun. A JSON config changes the config format, not the runtime.

**Why two commits?** The move commit contains only renames, so git reports
every file as R100 and a reviewer can skip it. Every real content change is
in the wiring commit.

**Should I commit the plan?** Yes. The approval commit (the manifest by
itself) is required, and the manifest is the permanent provenance record for
the extraction. Plans go in `planDir` (`.monocarve/plans` by default).

**Can I re-apply a plan?** No. Once its wiring commit has landed, the plan is
fully applied, and `--resume` says so. Use `status --plan <path>` to see where
a plan stands.

**Why did an old plan's audit start failing?** The audit checks the tree as
that plan left it. A later change to paths the plan owns, such as a second
extraction into the same package, breaks those equalities by design. Audit
immediately after apply, and use `receipt` to keep the passing result.

**How do I clean up leftover worktrees?** Run `monocarve prune-worktrees`
(worktrees older than one hour), `--all`, or `--worktree-root <path>` for a
specific directory.
