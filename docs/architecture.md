# Architecture

For contributors. This is a map of `src/`, the invariants a change may not
break, the quality gates a change must pass, and the test conventions.
Everything here is derived from the current source and from `AGENTS.md`,
which is the normative version of the invariants below — read it too.

## Module map and dependency direction

```
src/
  branding.ts        the only place the tool's own name appears
  errors.ts           error taxonomy (docs/errors-and-exit-codes.md)
  util/                hashing, paths, files, templates, git (environment-scrubbed)
  config.ts            public facade: the only supported programmatic import
                        (also the "." and "./config" package exports)
  config/               schema, loader, derived helpers, executable-config sandbox
                        (schema-core.ts, schema-artifacts.ts, schema-policy.ts,
                        loading.ts, snapshot-loader.ts, config-dependencies.ts, …)
  adapters/             package-manager + task-runner interfaces: pnpm, bun,
                        moon/none implementations, plus the not-yet-ported seams
  graph/                model, scanner adapter, components, workspace facts, layers
  portfolio/            candidate types, containment analysis, eligibility, ranking
  plan/                 manifest types, caches, consumers, dependencies, scaffold,
                        builder, validator, public-surface analysis
  prepare/              apply, audit, journal, simulate, boundary proofs, replay
  preparer/              declarative and command-driven preparer execution
  transaction/           worktree, journal, simulate, apply, audit, rollback,
                        interrupt handling, artifact regeneration, external-consumer
                        compile proof
  assessment/            snapshot capture, input inventory, qualification, evidence
                        publication/replay/recovery (docs/assessment.md)
  commands/             CLI command handlers; the thinnest layer, wiring the above
                        into subcommands
  codemod/               the one place import specifiers are read and rewritten
  checks/                repository checks (`check import-extensions`)
  seams/, symbols/, campaign/, consolidation/, evacuation/, reconciliation/,
  approval/, doctor/, impact/, path-migrations/, visualization/
                        supporting modules used by prepare/preparer/commands
  cli.ts                 executable boundary: parse, dispatch, classify failures
  cli/                   argument schema and strict parsing (src/cli/args.ts)
  build-identity.ts      compiler/executable build identity
  monocarve.ts            package entry point (binary)
fixtures/
  basic-monorepo/        synthetic moon + pnpm workspace used by tests
  bun-monorepo/           synthetic moon + bun workspace used by tests
test/
```

Dependency direction, confirmed against actual imports (`grep -rhoE 'from
"\.\./[a-z-]+' src/<dir>`):

```
util, errors  <  config  <  adapters  <  plan  <  prepare / preparer  <  transaction  <  assessment  <  commands
```

Concretely:

- `util` and `errors` import nothing from the rest of `src/` (errors imports
  nothing at all; util imports only `branding` and `errors`).
- `config` imports `branding`, `errors`, `util`.
- `adapters` imports `config`, `errors`, `util`.
- `plan` imports `adapters`, `config`, `branding`, `errors`, `util`, plus its
  own sibling modules (`codemod`, `graph`, `portfolio`).
- `prepare` and `preparer` import `plan`, `adapters`, `config`, `errors`,
  `util`, `graph`, `codemod`, and each other; `preparer` also imports
  `transaction` and `prepare`.
- `transaction` imports `adapters`, `plan`, `preparer`, `config`, `codemod`,
  `graph`, `evacuation`, `branding`, `errors`, `util`.
- `assessment` imports `adapters`, `config`, `plan`, `portfolio`, `graph`,
  `symbols`, `build-identity`, `branding`, `errors`, `util` — notably _not_
  `transaction` or `prepare`; assessment is read-only and does not depend on
  the mutating pipeline.
- `commands` imports from nearly every other top-level module (`assessment`,
  `transaction`, `prepare`, `preparer`, `plan`, `portfolio`, `graph`, `cli`,
  and the supporting modules) — it is the composition layer, not a layer
  other code imports back from.

`branding.ts` sits outside this chain: any module may import it for the
tool's own name and scratch/lock filenames, but nothing outside
`branding.ts` may hardcode the string `"monocarve"`.

## Key invariants

The full contract is `AGENTS.md`; these are the properties that most often
matter when reviewing a change:

- **Config-first.** Every fact about a particular repository lives in
  `src/config/*` (exposed through the `src/config.ts` facade) and nowhere
  else. A literal package scope, package root, application name, branch
  name, or project id anywhere in `src/` is a defect. Tool-specific values
  (the tool's own name, config filenames, scratch directory) live only in
  `src/branding.ts`.
- **Determinism.** Same repo + same commit + same config ⇒ byte-identical
  plan (`planId` included) and serialized manifest. No clock reads —
  `createdAt` is the baseline commit's committer date — no map iteration
  order, no randomness in anything hashed.
- **No partial application.** A journal either applies completely or
  restores every path it touched. There is no continue-on-error mode.
- **The move commit is pure renames.** Every path in it must be R100.
  Content changes belong in the wiring commit.
- **`move` is byte-identical**: `resultHash === preconditionHash`. A move
  whose content changes is `move-with-rewrite`, which carries a replay
  proof.
- **Simulation runs the repository's own gates**, never gates this tool
  invents.
- **Guarded branches are refusals, not warnings.**
- **Git is selected by `cwd` alone.** Every git invocation goes through
  `src/util/git.ts`, which strips `GIT_INDEX_FILE`, `GIT_DIR`,
  `GIT_WORK_TREE`, and similar variables from the child environment.
  Inheriting them lets a command run under a hook write into a _different_
  repository's index while `cwd` looks correct. Never call
  `execFileSync("git", …)` directly, in `src/` or in tests.
- **Proof discipline.** A proof that can pass when the thing it describes is
  wrong is worse than no proof, because it is trusted. When touching the
  audit or a validator: state what a failure would look like before writing
  the check; if a check cannot fail on a plausible bug, it is documentation,
  not a proof, and should say so or be deleted; add the negative test. Every
  audit proof in `test/transaction.test.ts` has a case that makes it fail.
- **The not-yet-ported policy.** Unimplemented seams throw
  `NotYetPortedError`, whose message begins `not yet ported`. `grep -rn "not
yet ported" src/` is the definitive list of what remains (currently the
  npm and yarn package-manager adapters, and the nx and turbo task-runner
  adapters). Never replace a stub with a partial implementation that returns
  plausible data — a caller trusting a wrong answer is worse than a caller
  getting a clear refusal.
- **Public repository hygiene.** Names, paths, scopes, commands, project
  ids, credentials, and provenance from real workspaces may not survive
  anywhere in the tree, including fixtures, tests, and commit messages.
  `fixtures/` uses the invented `@acme/` scope.

## The quality ratchet

Three gates under `scripts/quality/` measure the whole repository, not just
a diff: `max-file-lines.ts`, `complexity-check.ts` (cyclomatic/cognitive
complexity, nesting, method length, a structural score), and
`oxlint-check.ts` (oxlint's `--type-aware` findings). All three share one
ratchet mechanism (`scripts/quality/baseline.ts`) against a checked-in
baseline file (`complexity-baseline.json`, `max-file-lines-baseline.json`,
`oxlint-baseline.json`):

- Every violation present today is recorded in the baseline with its
  measured value.
- A violation **absent** from the baseline fails the gate — new debt is
  blocked.
- A recorded violation whose value got **worse** fails the gate — existing
  debt cannot grow.
- A recorded violation whose value **improved** passes, and the gate reports
  it, pointing at where the baseline can be tightened.
- A recorded violation with **no matching finding** at all is reported
  stale, so the entry can be removed instead of quietly protecting nothing.

Run `bun run <gate> --update-baseline` (`max-file-lines`, `complexity`,
`oxlint-ratchet`) to have the gate rewrite its baseline file to the current
measurements. Only do this deliberately: an `--update-baseline` run that
_raises_ a limit is hiding new debt, not recording an improvement — review
the diff of the baseline file itself the same way you would review any other
change, and prefer fixing the regression over widening its allowance.
`bun run quality` runs all three gates in enforcement mode (no baseline
update); `bun run check` runs `typecheck`, `test`, and `quality` together.

## knip

`knip.json` configures unused-export/unused-dependency detection with entry
points `src/monocarve.ts`, `src/config.ts` (the public facade, so its
re-exports count as used even with no in-repo caller), every `scripts/*.ts`
and `scripts/quality/*.ts`, and every `test/**/*.test.ts` plus
`test/support/evidence-publisher-child.ts` (a subprocess entry point knip
cannot infer from a normal import). Run `bun run knip` locally; it is not
wired into `bun run check` (verify against `package.json#scripts` if that
changes).

## Test layout and conventions

- Tests live under `test/` as `*.test.ts`, one file per concern rather than
  strictly one per module — `assessment-*.test.ts`, `apply-*.test.ts`,
  `boundary-*.test.ts`, and similar families group related proofs.
  `test/support/` holds shared fixtures and harnesses (`fixture-repo.ts`,
  `sandbox.ts`, `transaction-fixture.ts`, `cli.ts`, and others), not tests
  themselves.
- `bunfig.toml` scopes the test root to `test/`; `fixtures/` intentionally
  contains its own `*.test.ts` (an external-consumer compile proof), which
  is why it is excluded from the scoped root rather than merely ignored.
- Run tests with `bun run test`, not a bare `bun test`: the script sets
  `--timeout 60000`, because Bun's default 5s timeout is too short for some
  subprocess-backed CLI proofs, especially with the full suite running
  concurrently.
- **Executable-config tests need a real sandbox** (`bwrap`, `strace`,
  working unprivileged user namespaces). Positive-path tests
  (`test/assessment-config-authority.test.ts` and others that call
  `loadSnapshotConfig` or run `assess` against a `.ts` config) skip
  automatically, by name, when the sandbox is unavailable rather than
  failing. The fail-closed negative tests still run everywhere, since a
  missing sandbox and a real ambient-read violation both surface as the same
  `ASSESSMENT_CONFIG_UNBOUND`.
- **Scratch state** (fixture repositories, simulation worktrees) lives under
  a per-checkout cache directory by default (`src/util/scratch-root.ts`),
  not the repository itself; each suite cleans up what it creates.
  `MONOCARVE_SCRATCH_ROOT` redirects it when the default cache location is
  unsuitable for a host.
- **`git worktree add` may be blocked** by a local `git` wrapper on some
  hosts. Suites that create real simulation worktrees probe for this once
  and fail with an actionable message; set `ALLOW_GIT_WORKTREE_ADD=1` for
  the test run if you hit it.
- Every negative case that proves an audit/validator check earns its keep
  lives beside the positive case in the same file — see the proof-discipline
  invariant above.
