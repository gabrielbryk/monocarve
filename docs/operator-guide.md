# Monocarve operator guide

This guide is the safe, normal loop for one extraction. It uses invented names
and paths. Replace them with values declared by the target workspace's own
`monocarve.config.ts`; none of the examples are implicit defaults.

## Scope and prerequisites

Monocarve v1.0.0 is a Bun-only CLI. Run it with Bun from a committed checkout.
Its currently implemented workspace integrations are the pnpm package-manager
adapter and the moon or `none` task-runner adapters. A configuration that selects
another adapter fails at its explicit `not yet ported` seam; it does not fall
back to a plausible command.

Before the first extraction, make the workspace configuration complete:

- Declare applications, package roots, package scope, package manager, task
  runner, test and asset policy, and guarded branches.
- Supply root `scaffoldTemplates.packageJson`. Supply `tsconfig`, a task file,
  and `extraFiles` at the root or as an application override only when that
  workspace requires them.
- Put all scaffold content and commands in configuration. The tool has no
  built-in package layout, package metadata, or workspace-specific templates.
- Configure the repository's own gates. A simulation runs those commands; it
  does not invent a build, test, lint, or format command.

Use a feature branch. `apply --commit` refuses a branch listed in
`guardedBranches`.

## Preparing a declaration seam

Whole-file extraction remains the default. When a large file first needs a
type-only seam, configure repository-owned preparation policy:

```ts
preparation: {
  commit: { subject: "refactor({app}): prepare {targetPath}" },
  gates: { workspace: ["bun run check"] },
}
```

These strings illustrate workspace configuration; they are not built-in
defaults. Inspect candidates and compile only explicitly reviewed groups:

```sh
bunx monocarve seams --file apps/storefront/src/contracts.ts --candidate <candidate-id>
bunx monocarve prepare-plan --file apps/storefront/src/contracts.ts \
  --candidate <candidate-id> --group <group-id> \
  --target apps/storefront/src/contracts-types.ts \
  --module-specifier ./contracts-types.js --write
```

Review and commit that manifest directly atop its recorded baseline using its
rendered subject. Then run `prepare-apply --plan <path> --commit` and
`prepare-audit --plan <path>`. Preparation is one exact-scope content commit;
it never claims to be the extraction's pure-rename commit.

Campaigns sequence reviewed child plans in strict pairs: preparation, immediate
audit and fresh graph record, then a newly compiled extraction for the same
pair ID. `campaign advance` always rescans and queues one child for review; it
never applies it. `campaign record` records the applied child's real audit and
post-apply graph. Every later child is planned from the new HEAD. Keep the
mutable campaign ledger beneath the configured `campaignDir`; it is operational
state, not a versioned source change, and the CLI refuses another location.

Initialize a campaign with an explicit objective and protective bound, then use
the read-only status command before each operator step:

```sh
bunx monocarve campaign init \
  --campaign .monocarve/campaigns/storefront.campaign.json \
  --id storefront --objective "decompose the storefront" \
  --max-pairs 6 --write
bunx monocarve campaign status \
  --campaign .monocarve/campaigns/storefront.campaign.json
```

Initialization refuses captured graph reports and existing ledgers. Status does
not scan or write; it reports both the expected and observed HEAD, flags a stale
checkout with a non-actionable `stale-head` phase, and names the precise review
or application phase. The pair bound maps to two children per pair: one
preparation and one extraction.

## Rewriting path references in documents

When extracted code is referenced by path in configuration, documentation, or
other non-code files, those path tokens must be updated when the code moves.
The `pathReferenceRewrites` configuration enables automatic detection and
rewriting of exact path matches in declared document roots.

Unlike the path-reference warning scanner (which reports all found literals for
human review), this rewriter mutates file contents under journal during planning
and simulation. It therefore uses stricter matching rules:

- `matchExtensionless` defaults to `false` (not `true`): a bare stem like
  `configs/db` does not indicate which extension the moved file carries, so
  rewriting one is a guess. The warning scanner can afford to guess; the
  rewriter may not. When enabled, only stems whose source file has no extension
  are matched.
- One token must map to exactly one moved source. If the workspace has two
  moved files that normalize to the same token (e.g. `src/index.ts` and
  `src/index.js` both as `src/index`), the plan refuses rather than guessing
  which one the reference names.
- If `onAmbiguousMatch: "skip"` is set, ambiguous references are logged by
  location and reason in the plan review, never silently dropped.

Configure the rewriter by declaring document roots and their content types:

```ts
pathReferenceRewrites: {
  enabled: true,
  roots: [
    {
      root: "docs",
      extensions: [".md"],
      mode: "exact-path-token",
    },
    {
      root: "config",
      extensions: [".json", ".yml"],
      mode: "exact-path-token",
    },
  ],
  onAmbiguousMatch: "refuse",        // or "skip"
  matchExtensionless: false,         // or true
  maxBytes: 512 * 1024,              // skip files above this size
}
```

Each root declares a workspace-relative directory, the file extensions to scan,
and a matching mode. `exact-path-token` is currently the only mode. Tokens are
normalized path segments and do not match inside quoted strings, comments, or
variable names; they match only the exact substring normalized from the source
path.

Rewrite operations are included in the plan manifest with precondition and
result file hashes, journaled during apply, and audited before gates. A failed
apply restores both the moved source and the rewritten document.

If a configured post-journal preparer (such as a path-keyed baseline regenerator)
has a `triggers` pattern matching a rewritten document path, that preparer runs
after the rewrites are applied. Declare both in configuration when a prepared
artifact depends on the rewritten paths:

```ts
postJournalPreparers: [{
  id: "quality-ratchet",
  phase: "after-journal-before-gates",
  command: "node tools/promote-ratchet.mjs {targetPath}",
  outputs: ["quality/baselines/{targetPath}.json"],
  triggers: ["docs/"],              // matches rewritten doc paths
}]
```

`pathReferenceRewrites` is distinct from both `rewrite-fs-reference` and
`pathMigrations.artifacts`:

- `rewrite-fs-reference` handles statically resolvable references in TypeScript/
  JavaScript code: specifically `resolve(import.meta.dir, "literal")` patterns
  that the type checker can prove. It rewrites only source code, never documents.
- `pathMigrations.artifacts` run external commands to rewrite structured artifacts
  whose keys are source paths (e.g. a test-coverage baseline). They require a
  workspace-owned command and support complex transformations.
- `pathReferenceRewrites` scan declared document roots for exact path-shaped
  tokens and rewrite them by byte span. They require no external command and
  apply strict matching rules to avoid guessing.

A workspace often uses all three: path-reference warnings identify all found
literals; rewrite-fs-reference handles code; path migrations handle structured
artifacts; path-reference rewrites handle documentation and configuration.

## Normal extraction loop

Start with a clean feature branch and inspect the candidate selection:

```sh
bunx monocarve next --app storefront --write
```

`next` picks the highest-ranked eligible candidate, writes its manifest under
the configured plan directory, and prints its path. It does not commit or
modify source files. If the selection is not appropriate, inspect the
portfolio, choose another candidate, and compile that explicit plan instead:

```sh
bunx monocarve portfolio --app storefront --limit 20
bunx monocarve candidates --path apps/storefront/src/inventory --eligibility eligible
bunx monocarve candidates --candidate <candidate-id> --json
bunx monocarve plan --candidate c-example123 --package-name @demo/inventory --write
```

If a gate mutates a baseline, registry, or other generated file, attribute it
before editing configuration:

```sh
bunx monocarve inspect-gates --plan .monocarve/plans/c-example123.json
```

The report runs each gate from the same landed-plan state, names the exact
changed paths, and emits suggestions only. Review those paths before adding a
`generatedArtifacts` rule or configured preparer.

To add another candidate to an existing package, pass its workspace package
name. The graph resolves the existing root; `--package-root` is available only
when an explicit destination override is needed:

```sh
bunx monocarve plan --candidate c-example456 --package-name @demo/inventory --write
```

When that root already contains `package.json`, the planner extends its exports,
entrypoint, dependencies, project references, consumers, and existing lockfile
importer. It does not scaffold or register another package. Review those merged
edits, `target.packageRoot`, and every exact move target with the same care as a
new-package plan. Path-keyed lint or complexity baselines must use those exact
target paths, not a guessed flattened path; recompile the manifest after any
baseline commit. A named extraction profile owns
its destination and cannot be combined with manual package overrides.

If HEAD advances before application, refresh the reviewed plan without silently
changing its identity or overwriting it:

```sh
bunx monocarve refresh --plan .monocarve/plans/c-example456.json
bunx monocarve refresh --plan .monocarve/plans/c-example456.json \
  --out .monocarve/plans/c-example456-refreshed.json --write
```

Refresh refuses source, closure, target/profile, or execution-policy drift. The
first invocation is read-only; writing requires the explicit `--out` path.
For a baseline-only prep commit, `apply --commit --refresh-if-baseline-only` can perform
the same safe replacement in place. It succeeds only when the semantic diff is
empty, then stops with a non-zero status and prints the exact approval command;
it never combines refresh, approval, and application.

Review the manifest before approving it. In particular, review the baseline
commit, every operation and precondition/result hash, target package and
scaffold bytes, consumer rewrites, generated artifacts, rendered gate commands,
the evaluation-effects inventory, and both generated commit subjects. A plan is
an executable, hash-bound review artifact, not a suggestion.

### Provenance and commit metadata

The committed manifest is the provenance record for an extraction. It carries
the `planId`, baseline, declared operations and hashes, and rendered commit
metadata; the post-apply audit checks the landed tree against it. Keep that
manifest with the history and retain the audit result with the change review.

Commit subjects and optional bodies are entirely workspace-owned
`commitTemplates` policy. `apply` uses the rendered move and wiring subjects and
appends a configured body verbatim when one exists. The plan commit is made by
the operator; its subject must match the rendered `commits.plan` subject for
preflight, while its body is not used as extraction evidence. Monocarve does
not add, require, or verify an `Extraction-Proof` trailer. If the workspace
wants a trailer, co-author, or other commit body, configure it explicitly; it
does not replace the manifest or its audit.

Commit exactly the manifest as the configured plan commit. Then verify it
without changing the tree:

```sh
git add .monocarve/plans/c-example123.json
git commit -m 'chore(@demo/inventory): compile extraction plan c-example123'
bunx monocarve verify --plan .monocarve/plans/c-example123.json
```

The subject above is only an illustration; use the plan's rendered `commits.plan`
subject. `verify` validates manifest structure and semantics, checks journal
preconditions, checks a clean checkout, checks the branch policy, and confirms
that `HEAD` is the plan baseline plus exactly the approved manifest commit.
After reviewing the written manifest, `monocarve approve --plan <path>` shows
the exact path and rendered subject without changing Git. Re-run it with
`--commit` to create only that approval commit. `plan --write` prints the same
next actions, and `plan --write --commit-approval` is the explicit one-command
equivalent; both mutation forms refuse unrelated dirt and guarded branches.
Resolve every reported blocker before continuing.

Run the simulation explicitly, including the optional package-manager lockfile
comparison when the plan has a lockfile importer:

```sh
bunx monocarve apply --plan .monocarve/plans/c-example123.json --verify-lockfile
```

Without `--commit`, `apply` simulates only. It replays the journal in a
disposable worktree, regenerates configured artifacts, audits that tree, checks
the lockfile when requested, and runs the configured gates. The real checkout
is not changed. Its `transaction.nodeModules` strategy defaults to `symlink`;
`install` and `none` are available for workspaces whose gates need those
strategies. A passing simulation is the point at which the generated plan has
evidence that it can land.

After the simulation passes, commit the transaction:

```sh
bunx monocarve apply --plan .monocarve/plans/c-example123.json --commit --verify-lockfile
bunx monocarve audit --plan .monocarve/plans/c-example123.json
```

The committed apply repeats simulation first, then creates up to two commits:
the move commit contains only declared R100 renames; the wiring commit contains
scaffolding, import rewrites, lockfile changes, move-with-rewrite changes, and
regenerated artifacts. Audit the result immediately, before another extraction
changes paths that this plan owns. Audit checks declared byte fidelity,
consumer/boundary and compile evidence, codemod replay, entrypoint closure,
lockfile importer integrity, generated artifacts, and the recorded dynamic
import property. It is not a general proof that application behavior is
unchanged.

Simulation and committed application also run repository-wide structured
postconditions after the planned tree exists. They verify all registered
package manifests against their lockfile importers, reject duplicate dependency
declarations across manifest sections, and reject unresolved `workspace:`
dependencies. This complements the plan-local audit by detecting collateral
workspace drift outside the target and donor packages.

## Safety controls and expected refusals

### Dirty paths

Planning from a dirty tree is refused by default. A workspace may declare
`transaction.allowDirtyPaths` for unrelated files, but that is not a command
line override. The planner rejects an allowed entry if it overlaps a plan input,
plan output, source, consumer, generated artifact, or another baseline-sensitive
path. Commit or stash affected work; do not look for an `--allow-dirty` escape
hatch.

`apply --commit` requires no dirty paths except unrelated paths explicitly
listed in `transaction.allowDirtyPaths`. A normal apply also requires the
approved manifest commit to be the only change from the plan baseline before
the transaction begins.

### Guarded branches

`guardedBranches` is a hard refusal for committing applies, not a warning. Move
to a feature branch, retain the approved manifest commit, run `verify` again,
and then apply there. Simulation without `--commit` is still non-mutating, but
should not be used to bypass the branch policy for a real apply.

### Gates

Configured gates run in package, project, then workspace tiers. Commands may
run concurrently within a tier up to `gates.maxConcurrency`; tiers do not
overlap, and reported results keep declared command order. Gate failures stop
the transaction before the real checkout is changed.

`--skip-gates` is only for a non-committing, fast journal-and-audit simulation.
It is rejected with `--commit`, so a real apply cannot skip repository gates.
`transaction.simulateGates: false` is likewise a workspace policy choice; do
not use it as a substitute for validating a production extraction.

### Lockfile verification

The plan's lockfile operation is a deterministic splice. `--verify-lockfile`
adds a stronger, opt-in check: in the simulation worktree, Monocarve runs the
configured package manager's lockfile-only command and compares the resulting
lockfile with the plan's splice. Use it for a plan that changes a lockfile when
the package-manager run is available. A missing or failing package manager, or
any difference, fails the simulation; it is never treated as a skipped check.
If there is no lockfile-importer operation, there is nothing to compare and the
option has no lockfile verification result.

## Failure, rollback, and resume

Simulation failures leave the real checkout untouched. The JSON result includes
the failure plus structured `failedGate` evidence: tier, command, exit code,
bounded head and tail excerpts, and a full log path. Full logs live beside the
the retained failed simulation worktree under `transaction.worktreeRoot`, so
they do not dirty the gated checkout. They are not secret-redacted;
gate commands must not print credentials. A failed log write is reported as
`logWriteFailure` while the original gate result remains authoritative. The
result includes `worktreePath` and `gateRetry` with the exact cwd and configured
command; inspect that disposable worktree, fix the
workspace/configuration/plan cause in the real checkout, and make a new
reviewed plan if its baseline-sensitive inputs changed.

Once a committing apply starts, any failure triggers rollback. It restores the
pre-apply commit, snapshots of every transaction-owned path, and (when it could
be recorded) the pre-existing index. Rollback verifies the restored filesystem
state. A report containing `ROLLBACK INCOMPLETE` and `residue` means manual
recovery is required; preserve the evidence and resolve the named paths before
attempting another transaction.

`--resume` is narrowly for an interrupted committing apply. It accepts only two
states: the approved manifest commit, or the verified move commit with exactly
the manifest and declared move paths changed from the baseline. In the second
case it does not recreate the move commit; it completes the wiring commit.
It skips the ordinary clean-tree check so that pre-existing staging can be
preserved during recovery, but it still rejects an arbitrary `HEAD` and rejects
a plan whose wiring commit already landed. Do not use `--resume` to force a
changed plan or to ignore preflight failures.

A committing apply also holds a Git-common-dir ownership lock and records its
durable phase. After an interrupted client or shell timeout, run `apply-status`.
If the owner is stopped, run `apply-recover --plan <path>`; recovery changes no
Git state and prints the exact normal apply argv, adding `--resume` only at the
recorded move-commit boundary. Never reset the branch while the owner is alive.

When in doubt, stop after a refusal or failed simulation, inspect `git status`
and the reported plan/worktree, correct the cause, and repeat the safe loop from
plan review. Do not run internal transaction flags or manually stage a partial
journal as a recovery shortcut.
