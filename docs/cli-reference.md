# CLI reference

This reference mirrors the executable command registry. Run
`monocarve <command> --help` for the same usage and safety boundary at the
terminal. Commands print JSON whenever their result is structured or `--json`
is supplied; `--out` writes the same deterministic representation to a file
where supported.

## Global options

| option | meaning |
| --- | --- |
| `--config <path>` | Use an explicit config instead of discovering upward from `cwd`. |
| `--cwd <path>` | Start workspace and config discovery from this directory. |
| `--graph <app>=<file>` | Replay a captured scanner report; repeat for multiple applications. Campaign commands that require fresh evidence refuse it. |
| `--json`, `-j` | Request machine-readable output. |
| `--help`, `-h` | Show top-level or command help. |
| `--version`, `-v` | Print the CLI version. |

## Discovery and diagnosis

| command | usage and boundary |
| --- | --- |
| `plan` | `plan --candidate <id> ... [--verify-lockfile] [--out <path>] [--write] [--commit-approval] [--json] [--verbose]` — compile deterministically; terminals get the concise review while pipes and explicit machine modes retain the complete manifest. |
| `scan` | `scan [--app <name>] [--no-cache] [--include-extracted] [--out <path>]` — build the configured dependency model without editing the workspace. |
| `visualize` | `visualize [--app <name>] [--port <number>] [--no-open] [--no-cache] [--include-extracted]` — serve the current SCC-level dependency graph as an interactive loopback-only web UI. Search and edge-kind filters are local; Rescan rebuilds the read-only graph. |
| `layers` | `layers [--app <name>] [--out <path>]` — report domains, components, and dependency-first layers. |
| `portfolio` | `portfolio [--app <name>] [--limit <n>] [--recommendation <status>] [--strategy <cohesive\|max-loc\|low-risk\|campaign\|preparation>] [--include-extracted] [--communities] [--hub-inbound-threshold <n>] [--out <path>]` — show one representative per near-equivalent group; defaults to architecturally recommended candidates. |
| `candidates` | `candidates [--candidate <id> \| --equivalence-group <id>] [--path <path>] [--eligibility <all\|eligible\|blocked>] [--app <name>] [--include-extracted] [--out <path>]` — inspect candidate details, expand a grouped set of variants, or filter by claimed path and eligibility. |
| `evacuate` | `evacuate --app <name> --source <file\|directory\|glob> [--source <...>] --package-name <name> [--authorize-protected <configured-root>] [--include-composition <selected-root>] [--package-root <path>] [--verify-lockfile] [--out <path>] [--write] [--json]` — bounded domain analysis and ordinary immutable-plan compilation. Read-only by default; `--write` exclusively creates one manifest only after eligibility passes and every boundary cut has a configured remedy. The repeatable `--authorize-protected` escape hatch applies only here: each value must exactly equal a configured protected root contained by the selected application and requested evacuation. The evacuation-only, repeatable `--include-composition` flag may name only an exact composition root already matched by the selectors in that application. Its entire SCC moves; outbound application dependencies remain ordinary reported cuts. Omitted composition roots retain the default behavior. Canonical authorizations and inclusions are recorded in the report and immutable manifest provenance and change its plan identity. Tests and assets remain blocked unless they are beneath an explicitly authorized selected root. Multiple route and wiring roots may be included in one evacuation by repeating both `--source` and `--include-composition`. |
| `scope` | `scope --path <source> --package-name <name> [--app <name>] [--verify-lockfile] [--out <path>] [--write] [--json]` — resolve a stable principal path, compile its current plan, and show the concise review without writing by default. |
| `backlog` | `backlog [--app <name>] [--limit <n>] [--include-extracted] [--marginal] [--out <path>]` — explain blocked candidates; marginal mode is only a one-blocker lower bound. |
| `config-doctor` | `config-doctor` — report the discovered config and root, effective value provenance, application and package resolution, adapter availability, compiler profiles, generated and path-keyed artifacts, configured module calls, protected and dirty paths, and preparation coverage. It is strictly read-only: no gates, generators, installers, or preparers run. JSON configs report `explicit` versus `default` provenance; dynamically loaded configs report `unknown` where the original shape is not safely recoverable. |
| `explain` | `explain --plan <path> (--dependency <name> \| --artifact <path>) [--json]` — read persisted provenance for one dependency decision or the exact operation chain and final hash for one artifact. |
| `symbols` | `symbols --file <path> [--out <path>]` — declaration graph, type/value spaces, merged groups, exact references, and SCCs for one file. |
| `split-candidates` | `split-candidates --file <path> [--app <name>] [--out <path>]` — rank declaration SCCs using external consumers and domain affinity. |
| `capabilities` | `capabilities --file <path> --type <interface> [--out <path>]` — group context properties by real TypeScript consumer affinity. |
| `lazy-registry` | `lazy-registry --file <path> [--app <name>] [--out <path>]` — map resolved dynamic imports to domains and candidate targets. |
| `hotspots` | `hotspots [--app <name>] [--limit <n>] [--out <path>]` — rank closure-inflating modules and preparation levers. |
| `impact` | `impact --plan <preparation-manifest> [--app <name>] [--out <path>]` — gate and rescan a disposable counterfactual, then report exact deltas. |
| `seams` | `seams --file <path> --candidate <id> [--target <path>] [--app <name>]` — propose one reviewed declaration seam and its safety blockers. |
| `seams-multi` | `seams-multi --file <path> --file <path> [--app <name>]` — analyze exact symbol edges and SCCs across at least two explicit files. |
| `conflicts` | `conflicts --plan <candidate>=<manifest> [--plan <candidate>=<manifest> ...]` — compare same-baseline path ownership. Every wave still requires replan between applied children. |
| `check` | `check import-extensions` — run the configured package import-extension policy. |

## Extraction planning

```text
plan --candidate <id>
     [--profile <name> | --package-name <name> [--package-root <path>]]
     [--force] [--out <path>] [--write [--commit-approval]]
```

`plan` compiles a hash-journaled manifest but does not edit source. An explicit
package name resolves its root from the workspace graph when that package
already exists; `--package-root` is an optional override. A root containing
`package.json` is extended, otherwise a new package is scaffolded. Named profiles
own their target and cannot be overridden. `--force` bypasses portfolio eligibility only;
validation, preconditions, simulation, branch policy, and audit remain mandatory.
The result names `targetMode` (`existing` or `new`) and `targetPackageRoot` so
automation does not need to infer topology from scaffold operations. `next`
reports the same fields.

With `--write`, the result also reports the exact manifest path, rendered
approval subject, `git add` argument vector, explicit `approve` command, and
subsequent `apply` command. Nothing is approved implicitly. Add
`--commit-approval` only after review to create a commit containing exactly the
manifest; it requires `--write` and refuses any other staged, modified, or
untracked path.

| command | usage and boundary |
| --- | --- |
| `plan-review` | `plan-review --plan <path> [--approval-subject <subject>] [--json]` — render the deterministic, read-only operator review, including exact move targets and approval inputs. |
| `next` | `next [--app <name>] [--profile <name>] [--package-name <name>] [--write] [--apply] [--verify-lockfile]` — choose the highest-ranked candidate; `--apply` simulates only. |
| `relocate-tests` | `relocate-tests --suite <name> [--out <path>] [--write]` — compile a configured leaf integration-test package. |
| `refresh` | `refresh --plan <path> [--out <new-path> --write [--commit-approval]]` — safely recompile a stale plan at current `HEAD` to a distinct immutable review artifact. |

To append a candidate to an existing package:

```sh
monocarve plan --candidate <id> --package-name @acme/existing --write
```

Review `target.packageRoot` and every move operation's exact target path before
committing the manifest. The plan extends existing package exports, entrypoint, dependencies, project
references, consumers, and lockfile blocks. It does not recreate or register
the package.

Run `monocarve plan-review --plan <path>` before approval for a human-readable
review of target mode, exact top-level and nested move targets, operation counts,
dependency and consumer wiring, public exports, generated outputs, repository
gates, and warnings. Add `--json` for its stable structured form. The approval
section records the manifest path and defaults its subject to `commits.plan`;
`--approval-subject` supplies a different exact proposed subject for review.

If a repository gate reports a moved file, use the target path recorded in the
manifest—not a guessed flattened package path—when updating path-keyed lint,
coverage, or complexity baselines. Any baseline change alters HEAD, so compile
and commit a fresh manifest afterward.

For a stale reviewed plan, `refresh` resolves the same candidate from a fresh
graph and refuses dirty workspaces or drift in the application, target,
profile, source closure, source bytes, gates, or commit policy. It reports a
`semanticDiff` separately from baseline provenance changes:

```sh
monocarve refresh --plan .monocarve/plans/c-example.json
monocarve refresh --plan .monocarve/plans/c-example.json \
  --out .monocarve/plans/c-example-refreshed.json --write
```

The first command cannot write. The second writes a separate file exclusively;
add `--commit-approval` only after reviewing the semantic diff. Reviewed plan
bytes are immutable: `--replace` and apply-time refresh are refused. `plan
--write` also refuses an existing output instead of silently overwriting it.

Every compiled plan also carries `projectedArtifacts`, the canonical final
hashes of its structured outputs, and `dependencyDecisions`, the source paths
and production/test/type-only reasons behind target additions and reviewed
donor removals. Validation refuses either record when it contradicts the
operation journal or declared dependency sections.

Use `explain` when reviewing either record without re-running discovery:

```sh
monocarve explain --plan .monocarve/plans/c-example.json --dependency library
monocarve explain --plan .monocarve/plans/c-example.json --artifact libs/example/package.json
```

The command is read-only and accepts exactly one selector. Its JSON form is a
stable projection of evidence already bound into the reviewed manifest; it
does not infer new reasons from the current checkout.

## Extraction execution

| command | usage and boundary |
| --- | --- |
| `approve` | `approve --plan <path> [--commit]` — validate and display exact approval evidence without mutation; `--commit` explicitly commits only the manifest. |
| `verify` | `verify --plan <path>` — read-only manifest validation plus apply preflight. |
| `doctor` | `doctor --plan <path> [--verify-lockfile]` — replay, audit, and run repository gates in a disposable worktree. |
| `inspect-gates` | `inspect-gates --plan <path>` — run every declared gate separately against the landed plan, attributing exact repository-visible changed paths and suggesting missing generated-artifact declarations without changing the checkout. |
| `apply` | `apply --plan <path> [--commit] [--resume] [--skip-gates] [--verify-lockfile]` — always simulates first; without `--commit`, the checkout is unchanged. |
| `apply-status` | `apply-status` — read-only durable phase and owner evidence for a committing apply. |
| `apply-recover` | `apply-recover --plan <path>` — release only a stopped matching owner, then print the verified apply/resume argv. |
| `audit` | `audit --plan <path> [--skip-compile-proof]` — independently verify the tree produced by the plan. Run it immediately after apply. |
| `status` | `status [--plan <path>] [--receipt <path>] [--reconciliation <path>]` — classify exact approval/application evidence, current audit state, and optional immutable evidence, then print one safe next command. |
| `reconcile` | `reconcile --plan <path> --reason <text> --approval-subject <subject> [--out <path>] [--write]` — compile a separate immutable record for declared byte/generated drift without changing the approved plan. |
| `reconcile-approve` | `reconcile-approve --record <path> [--commit]` — inspect or create the exact record-only approval commit. |
| `receipt` | `receipt --plan <path> [--reconciliation <approved-record>] [--out <path>] [--write]` — compile an immutable passing-audit receipt linked to the exact application and, when supplied, approved reconciliation. |

`--skip-simulation` is explicitly refused. `--resume` accepts only a verified
transaction boundary. `--skip-gates` does not bypass validation, journal,
scope, or audit proofs; normal operation should run the configured gates.
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

## Declaration preparation

| command | usage and boundary |
| --- | --- |
| `prepare-plan` | `prepare-plan --file <path> --candidate <id> --target <path> --module-specifier <specifier> --group <id> [--group <id> ...] [--out <path>] [--write]` — compile only explicitly reviewed type-only groups. |
| `prepare-multi-plan` | `prepare-multi-plan --spec <path> [--out <path>] [--write]` — compile exact reviewed per-donor members into one atomic multi-file preparation. |
| `prepare-apply` | `prepare-apply --plan <path> [--commit]` — isolated replay by default; with `--commit`, require approved-manifest provenance and audit immediately. |
| `prepare-audit` | `prepare-audit --plan <path>` — independently replay declaration, import, graph, mode, and public-surface evidence. |

Preparation uses the workspace's configured `preparation.commit` and non-empty
`preparation.gates`; CLI flags cannot invent or remove that policy.

`prepare-multi-plan --spec <path> [--out <path>] [--write]` accepts a reviewed
JSON specification containing one multi-file candidate and at least two
per-donor members (`file`, local `candidate`, `target`, `moduleSpecifier`, and
exact `groups`). The union must exactly cover the atomic multi-file SCC. Each
donor transform is independently replayable, targets may not collide, all
cross-file edges must be type-only, and the result is one manifest committed,
audited, and rolled back as a unit.

## `boundary`

```text
boundary review --id <boundaryId>
boundary compile --id <boundaryId> [--target <path>] [--template <id>]
                  [--var key=value ...] [--out <path>] [--write]
boundary simulate --plan <manifest>
boundary apply --plan <manifest> [--commit]
```

`boundary` compiles one declared entry from `compositionBoundaries`,
`portPromotions`, `modulePromotions`, or `generatedSourceAdoptions` — see
"Boundary preparation" in the operator guide for their distinct proof
boundaries. `review` is read-only: it resolves the entry and
reports its baseline importers as discovered by a fresh dependency-graph
scan, for inspection before compiling. `compile` re-derives that same
importer set itself from the graph — it never accepts a hand-typed importer
list — and refuses `retire` outright unless the graph proves no importer of
the retained module survives. `--target <path>` is the promoted contract's
destination and is required for `strategy: "port"`; it is refused for
`existing-package`, which only rewrites specifiers. `--template <id>` names
an entry in `scaffoldTemplates.extraFiles` holding the reviewed adapter body
for a `port` boundary that declares `appAdapter` — Monocarve never
synthesizes adapter code, only renders a template a human already reviewed.
`--var key=value` (repeatable) supplies additional template substitution
values. `simulate` replays a compiled manifest in a disposable worktree
without landing it; `apply` does the same and, with `--commit`, commits the
result — matching `prepare-apply`'s exact simulate-then-commit shape.

## Configured preparers and ratchets

| command | usage and boundary |
| --- | --- |
| `preparer-plan` | `preparer-plan [--extraction <path>] --preparer <id> --source <path> [--bootstrap-config <path>] [--out <path>] [--write]` — run one configured preparer in a disposable baseline worktree and compile its declared outputs into a reviewable manifest. Without an extraction, `source` is the standalone policy anchor. |
| `preparer-bootstrap-commit` | `preparer-bootstrap-commit --plan <path> --subject <subject>` — for a plan compiled with `preparer-plan --bootstrap-config <path>`, temporarily materialize reviewed outputs so normal hooks can validate the introducing config, commit only the exact config and manifest, then roll the outputs back. |
| `preparer-simulate` | `preparer-simulate --plan <path>` — replay captured outputs and their configured verification without changing the checkout. |
| `preparer-apply` | `preparer-apply --plan <path>` — require the exact manifest as the sole commit directly above its extraction baseline, simulate first, then journal-apply reviewed outputs with rollback; never commits the outputs. |
| `preparer-commit` | `preparer-commit --plan <path>` — verify exact applied bytes and modes, refuse guarded branches or any extra dirty path, and commit only declared outputs with configured metadata. |

Preparers are generic repository-owned pre-extraction policies. Each config
entry declares an `id`, `phase: "pre-extraction"`, one or more of `replacements`,
`creates`, and `command`, output path templates, an optional `verify` command, and commit
metadata. Templates may use `{app}`,
`{package}`, `{packageRoot}`, `{planId}`, `{sourcePath}`, and `{targetPath}`;
the last two come from one exact byte-identical move in the extraction
manifest. Planning refuses undeclared writes and non-UTF-8 output files.

```ts
preparers: [{
  id: "quality-ratchet",
  phase: "pre-extraction",
  command: "node tools/promote-ratchet.mjs {targetPath}",
  outputs: ["quality/baselines/{targetPath}.json"],
  verify: "node tools/check-ratchet.mjs {targetPath}",
  commit: { subject: "chore: promote ratchet for {targetPath}" },
}]
```

For a source edit that does not need a repository helper, declare ordered text
replacements instead:

```ts
preparers: [{
  id: "tighten-widget-limit",
  phase: "pre-extraction",
  replacements: [{
    path: "{sourcePath}",
    prefix: "export const widget = { ",
    before: "limit: 10",
    after: "limit: 20",
    suffix: " };",
  }],
  outputs: ["{sourcePath}"],
  commit: { subject: "refactor: tighten widget limit" },
}]
```

Replacement entries execute in array order and later entries read the bytes
produced by earlier ones. Each requires `path`, `before`, `after`, and at least
one of `prefix` or `suffix`. The exact framed before-state (`prefix + before +
suffix`) must occur once; zero matches proceed only when the exact framed
after-state occurs once. An ordered chain on the same path and with the same
anchors is also idempotent at its terminal after-state when each preceding
`after` exactly names the next `before`. Ambiguous before-states and unrelated,
unanchored after text are refusals rather than guesses.

The replacement `path` is template-rendered using the preparer's binding. The
`before`, `after`, `prefix`, and `suffix` fields are literal source text and are
never template-rendered, so braces in JSX and similar syntax remain exact.

New UTF-8 files can be declared without a helper command. Create paths are
automatically included in the output set; `contents` is literal, while `path`
uses the same binding templates as replacements. Mode defaults to `0o644` and
may be `0o755`:

```ts
preparers: [{
  id: "add-widget-contract",
  phase: "pre-extraction",
  creates: [{
    path: "{packageRoot}/src/widget-contract.ts",
    contents: "export interface WidgetContract {}\n",
  }],
  commit: { subject: "refactor: add widget contract" },
}]
```

Planning requires each create path to be absent, or already be a regular file
with the exact declared bytes and mode. Different existing state, duplicate
create paths, explicitly repeating an automatic create output,
replacement/create overlap, and paths outside the workspace are refused. The
manifest records the missing-or-existing precondition and exact
result bytes, hash, and mode.

Every replacement `path` must also be named by `outputs`. Operations execute in
the explicit order replacements, creates, optional command, then `verify`.
Planning still rejects every repository-visible changed path outside
`outputs`, then captures the rendered policy and final UTF-8 bytes in the
reviewable preparer manifest.

The preparer manifest is separate from the extraction manifest so its exact
hashes, modes, rendered commands, resolved replacement paths, literal
replacement bodies, and destination binding can be reviewed on
their own. Commit that manifest alone directly above the extraction baseline
before application; no approval subject is prescribed. No output commit subject
is inferred: commit the applied outputs yourself according to repository
policy—or use `preparer-commit` to enforce the configured subject and exact
scope—then regenerate the extraction plan from the new `HEAD` because the
reviewed extraction manifest is now stale. Verification commands run only in
disposable worktrees, never during real-checkout journal replay. Ignored scratch
writes are discarded with that worktree and are not captured or applied.

When adding a preparer whose generated output is already required by commit
hooks, compile the standalone plan while only the config is dirty with
`--bootstrap-config <path>`. Review the manifest, then run
`preparer-bootstrap-commit`. The transaction materializes reviewed outputs and
uses a temporary copy of Git's index: tracked outputs are marked unchanged and
new outputs are hidden by a transaction-local excludes file, while only config
and manifest are staged. Full-tree gates therefore see the repaired files,
staged-scope hygiene sees the exact intended approval commit, and the ordinary
`git commit` runs every repository hook. The temporary index produces a commit
containing only config and manifest; Monocarve then advances the real index and
restores the outputs before the normal `preparer-apply` lifecycle.

Preparers that must inspect the moved tree use `postJournalPreparers`. Each
declares `phase: "after-journal-before-gates"`, a command, exact outputs,
optional move-path triggers, and an optional verification command. Outputs are
recorded in the extraction manifest, regenerated before audit and gates, and
included in the wiring commit. Undeclared repository changes still fail the
changed-scope audit.

Use a pre-extraction preparer for deterministic source compatibility edits
(strict TypeScript fixes, test-environment directives, or explicit ambient
stubs), then `preparer-commit` and regenerate the extraction plan. Use a
post-journal preparer only for declared artifacts whose computation requires the
destination paths, such as path-keyed lint or complexity baselines. This split
preserves the extraction move commit as pure R100 renames.

With `transaction.nodeModules: "install"`, simulation installs twice: once at
the baseline and again after the journal creates package manifests and lockfile
importers. The second install proves that a newly scaffolded package can resolve
the dependencies declared by the plan.

Asset consumers are planned with the same exactness as code consumers. A
retained TypeScript/JavaScript import of a moved configured asset—including a
query suffix such as `?url`—is rewritten to the asset's package subpath. For
ordered stylesheet manifests, list their configured extensions in
`cssImportExtensions`; `@import` references are then discovered and rewritten
by literal span. Shared assets therefore require a subpath public surface;
barrel-only plans refuse instead of emitting an unresolvable package-root import.

## `campaign`

New campaigns use stable source identities rather than candidate IDs:

```sh
monocarve campaign optimize --app storefront --out campaign.targets.json --write
monocarve campaign resolve --targets campaign.targets.json
```

The target file contains an application and an ordered `targets` array of
`{ "path": "apps/web/src/feature.ts", "packageName": "@acme/feature" }`.
Resolve always scans current HEAD, skips targets no longer owned by the
application, compiles at most one current candidate, and stops for review. It
writes the plan only with `--write`. This lets candidate IDs change after each
applied extraction without invalidating the campaign definition.
`campaign optimize` orders these stable targets by extracted LOC per deterministic
review unit and includes read-only coupling hotspots as preparation priorities.

The commands below are retained only to finish existing schema-v1 pair ledgers:

```text
campaign init --campaign <ledger> --id <id> --objective <text>
              --max-pairs <count> [--write]
campaign status --campaign <ledger>
campaign advance --campaign <ledger>
                 [--next-plan <manifest> --pair <id>] [--write]
campaign record --campaign <ledger> --plan <manifest> --pair <id> [--write]
```

Campaign ledgers must live beneath configured `campaignDir` and be git-ignored.
`init` and `advance` require fresh native scans and refuse captured `--graph`
evidence. `advance` queues exactly one reviewed child and never applies it.
`record` audits and records an already-applied child with a fresh post-apply
scan. `status` is read-only and reports stale HEAD as non-actionable.

## Exit codes

| code | meaning |
| --- | --- |
| `0` | Command completed and its reported proof passed. |
| `1` | Expected domain operation completed with a failed validation, simulation, check, or audit result. |
| `3` | A selected adapter or integration is explicitly not yet ported. |
| `64` | Invalid command usage or refused operator input. |
| `70` | Unexpected internal defect; the CLI prints the full cause chain. |
