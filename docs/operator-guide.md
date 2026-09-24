# Monocarve operator guide

This guide is the safe, normal loop for one extraction in a real workspace,
plus the preparation, boundary, and recovery procedures around it. It uses
invented names and paths. Replace them with values declared by the target
workspace's own `monocarve.config.ts`; none of the examples are implicit
defaults.

For a first walkthrough on a small example, read
[Getting started](getting-started.md). For the model behind plans, journals,
simulation, recovery, and audit proofs, read [Concepts](concepts.md). For
specific refusals, read [Troubleshooting](troubleshooting.md).

## Scope and prerequisites

Monocarve is a Bun-only CLI for Linux. Run it with Bun from a committed
checkout. Its implemented workspace integrations are the pnpm and bun
package-manager adapters and the moon or `none` task-runner adapters. Config
validation rejects any other adapter (`npm is not supported yet; supported package managers: pnpm, bun`); Monocarve never falls back to a plausible
command.

To take a reproducible, read-only snapshot of an application's architecture
before planning (layers, hotspots, portfolio, backlog), use
`assess --app <name> --evidence-dir <path>`; see
[Architecture assessment](assessment.md).

The bun adapter declares workspace membership in the root `package.json`
`workspaces` array and edits `bun.lock`. A package occupies two places in that
file — an entry in `workspaces` mirroring its manifest, and an entry in
`packages` declaring the workspace link — and the plan moves both together. Set
`packageManager: "bun"` and nothing else changes about the loop below.

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

New multi-extraction campaigns use stable source targets:
`campaign optimize --app <name> --out <targets> --write` ranks them, and
`campaign resolve --targets <targets>` rescans HEAD and compiles at most one
plan for review (see [Concepts](concepts.md#campaigns)).

Legacy schema-v1 pair campaigns remain supported only to finish existing
ledgers. They sequence reviewed child plans in strict pairs: preparation,
immediate audit and fresh graph record, then a newly compiled extraction for
the same pair ID. `campaign advance` always rescans and queues one child for
review; it never applies it. `campaign record` records the applied child's real
audit and post-apply graph. Every later child is planned from the new HEAD.
Keep the mutable campaign ledger beneath the configured `campaignDir`; it is
operational state, not a versioned source change, and the CLI refuses another
location. The ledger commands look like this:

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

## Boundary preparation

A `retainedRoots` candidate is one an app module is not eligible to leave
because something it still owns is genuinely app-specific — a shim for a
package that already exists, or a real concrete type a portable module
depends on. Boundary preparation unblocks that candidate by compiling exactly
the substitution a reviewer already declared, from either of two related but
**not interchangeable** config vocabularies. Monocarve validates a
reviewer-declared contract; it never infers or guesses one on its own — a
config gap here is a hard refusal, not a best-effort substitution.

### `compositionBoundaries` (frontend vocabulary)

```ts
compositionBoundaries: [
  {
    id: "storage-shim",
    retained: "apps/storefront/src/storage.ts",
    strategy: "existing-package",
    replacement: { specifier: "@acme/storage", symbols: ["Storage"] },
    retire: true,
  },
  {
    id: "clock-port",
    retained: "apps/storefront/src/clock.ts",
    strategy: "port",
    contract: "Clock",
    contractModule: "clock",
    appAdapter: "apps/storefront/src/clock-adapter.ts",
    packageImport: "@acme/scheduling/clock",
    symbols: ["Clock"],
    template: "clock-adapter",
  },
];
```

Each entry names one `retained` app module and a `strategy`:

- `"existing-package"` — the retained module is a shim for a package that
  already exists. Every consumer is rewritten to import `replacement.specifier`
  instead, using exactly `replacement.symbols`; an import of any other symbol
  from the shim is refused, not silently dropped. `retire: true` deletes the
  shim once — and only once — every baseline importer has been rewritten in
  the same manifest.
- `"port"` — the retained module is genuinely app-specific. A portable module
  instead imports a `contract`/`contractModule` from `packageImport`; the app
  keeps its own concrete implementation in place. `contract`, `contractModule`,
  `appAdapter`, `packageImport`, a non-empty `symbols` list, and a reviewed
  `template` id are all required together — Monocarve never fills in a missing
  half of a port declaration.

### `portPromotions` (backend vocabulary)

```ts
portPromotions: [
  {
    id: "clock-port",
    retainedRoots: ["apps/scheduler/src"],
    contractPackage: "@acme/scheduling",
    contractModule: "clock",
    appConcreteType: "apps/scheduler/src/clock.ts#Clock",
    libraryPort: "Clock",
    targetPackage: "@acme/scheduling-contracts",
  },
];
```

`portPromotions` describes the same "port" mechanism from a library's point of
view: a package depends on a port interface (`libraryPort`), and the app's
current concrete type (`appConcreteType`, as `"path/to/file.ts#TypeName"`)
already satisfies it in place. `libraryPort` must name the exact same
declaration `appConcreteType` does — the preparation engine moves a
declaration's bytes verbatim and cannot synthesize a rename. Unlike
`compositionBoundaries`' `"port"` strategy, a promotion never declares an
`appAdapter`: the app's existing concrete type is expected to already satisfy
the promoted contract structurally, so nothing is rendered from a template.

Both vocabularies share one `id` namespace: reusing the same `id` in both
`compositionBoundaries` and `portPromotions` is refused.

When one port declaration depends on another declaration in the same donor,
declare the complete atomic group instead of relying on implicit widening:

```ts
portPromotions: [
  {
    id: "object-storage-port",
    retainedRoots: ["apps/scheduler/src/storage"],
    contractPackage: "@acme/storage-contracts",
    contractModule: "object-storage",
    appConcreteTypes: ["apps/scheduler/src/storage/object-storage.ts#DownloadedObject", "apps/scheduler/src/storage/object-storage.ts#ObjectStorage"],
    libraryPorts: ["DownloadedObject", "ObjectStorage"],
    targetPackage: "@acme/storage-contracts",
  },
];
```

`appConcreteTypes`/`libraryPorts` is mutually exclusive with the legacy
singleton `appConcreteType`/`libraryPort` form. The arrays must be non-empty,
paired in equal lengths, name declarations without renaming them, and point to
one donor file. Monocarve computes the local declaration dependency closure
and accepts the group only when the configured declarations equal that closure
exactly. Value-space dependencies and omitted type dependencies are refusals.
Contract declarations are emitted in donor source order, and each importer is
rewritten with only the promoted bindings it actually imports. An importer
that binds only declarations remaining in the donor is left untouched. A
mixed named import is split deterministically: promoted bindings move to the
contract specifier while non-promoted bindings keep importing the donor. The
manifest records both sides of that split, so validation refuses an omitted or
invented retained binding.

A port boundary may add a contract module only to a package that already
exists at the plan baseline and whose `package.json` name matches the declared
target package. Boundary preparation manifests do not carry the extraction
planner's complete package-scaffold lifecycle (workspace membership, task
registration, solution references, lockfile importer, and public exports), so
Monocarve refuses a missing target package instead of writing a misleading
`src/*` fragment. Scaffold the package first through the configured standard
package lifecycle, commit that prerequisite, then compile the boundary.
For an existing `portPromotions.targetPackage`, boundary compilation adds the
declared `contractModule` as one deterministic package export and rewrites
consumers to `contractPackage`. An identical export is idempotent; an occupied
subpath pointing elsewhere, a contract-package/subpath mismatch, or a manifest
whose export no longer maps the promoted contract is refused by compilation
and manifest validation.

### Module promotion (architectural boundary cuts)

```ts
modulePromotions: [
  {
    id: "resource-contracts",
    source: "apps/api/src/resources/schemas.ts",
    targetPackage: "@acme/resource-contracts",
    targetModule: "index",
    retireSource: true,
  },
];
```

A module promotion is an explicit exception to ordinary SCC-closure selection.
The reviewer selects exactly one complete source module; compilation derives
every importer from the fresh graph and the compiler's own reference index,
then emits an ordinary extraction manifest. Package scaffolding, dependencies,
exports, tests, path migrations, simulation, apply, and audit therefore use the
same engine as any other extraction. When the source belongs to a multi-file
SCC, the manifest records the baseline SCC, every incident edge removed by the
promotion, and the SCCs left after the cut; compilation still requires the
largest SCC to shrink. A singleton source instead carries a containment-cut
proof: at least one cross-domain or cross-application edge must disappear, the
application containment-edge count must improve by that exact amount, and the
new package may not depend on any application module. Both paths refuse a
partial importer inventory. Direct test importers use the ordinary relocation
policy: only self-contained, source-owned tests travel with the module; tests
that reach another domain's application support remain in place and have their
imports rewritten. The importer proof is the exact union of those relocated
tests and retained consumers. Review and compilation derive that inventory from
the union of the fresh dependency graph and the compiler reference index, so
imports under configured `consumerRoots` are visible even when the graph scan
does not include those directories.

`targetModule: "index"` exposes the moved module at the package root. A
subpath value uses the configured public-surface templates. `retireSource: true`
removes the old module path; `false` recreates it as a compatibility
re-export in the wiring commit. Committed apply temporarily withholds that
re-export while staging the move, independently verifies the first commit is
R100, then restores and commits the compatibility file with the other wiring.

### Adopting orphaned generated source

```ts
generatedSourceAdoptions: [
  {
    id: "durable-contracts",
    // Optional: required when every artifact is outside configured applications.
    policyAnchor: "apps/api/src/adoption-policy.ts",
    artifacts: [{ path: "apps/api/src/resources/schemas.ts", missingSource: "spec/resources.schema.json", removeHeaderLines: 3 }],
    retireGenerator: "apps/api/scripts/generate-contracts.ts",
  },
];
```

This preparation is deliberately explicit. Compilation verifies the artifact's
configured provenance marker, verifies the named source is absent at the exact
Git baseline, and records both the removed header hash and complete adopted
bytes. `retireGenerator` is optional; when present, Monocarve scans every
tracked baseline file and refuses deletion unless every provenance header that
names that generator belongs to the same adoption. Simulation and audit replay
the exact before/after bytes and prove both source absence and generator
deletion. A later module-promotion plan is compiled only after this adoption
lands, so orphaned generated output is never silently treated as source.

The compiler records one application-owned policy anchor and simulation,
apply, and audit reproduce policy from that exact configured choice. Artifacts
may span applications and existing `packageRoots`; package files do not need
fake `applications` entries. By default the first artifact is the anchor. For
an all-package adoption, configure `policyAnchor` as a real application-owned
path whose repository policy should govern the operation.

### Compiling and applying a boundary

```sh
bunx monocarve boundary review --id storage-shim
bunx monocarve boundary compile --id storage-shim --write
bunx monocarve boundary compile --id clock-port \
  --target apps/storefront/src/contracts/clock.ts \
  --template clock-adapter --write
bunx monocarve boundary simulate --plan .monocarve/plans/prepare-<id>.json
bunx monocarve boundary apply --plan .monocarve/plans/prepare-<id>.json --commit
```

`review` reports the resolved boundary, module promotion, or generated-source
adoption and its applicable baseline evidence, discovered from a fresh
dependency-graph scan, before compiling. `compile` re-derives
that same importer set itself from the graph — an operator cannot hand it a
partial list — and refuses `retire` unless the graph itself proves no
importer of the retained module survives after this manifest's own rewrites;
a module the graph has no evidence for refuses retirement outright rather
than trusting an absence of evidence as evidence of absence. `--target` is
required for `"port"` (the promoted contract's destination) and refused for
`"existing-package"` (which only rewrites specifiers, creating nothing new).
`--template <id>` resolves a `"port"` boundary's `appAdapter` body from
`scaffoldTemplates.extraFiles` — the adapter is rendered only from a template
a human has already reviewed, never synthesized. `simulate`/`apply` share the
same replay-then-gate shape as `prepare-apply`.

### The full refusal list

Boundary compilation and its post-apply audit refuse, rather than repair:

- an `"existing-package"` consumer importing a symbol outside the declared
  `replacement.symbols`;
- a specifier rewrite that resolves to nothing (no effect);
- `retire: true` on a shim the importer graph has no evidence for, or whose
  rewritten importer set the graph cannot prove is exhaustive;
- a `"port"` declaration or explicitly declared atomic group that is not a
  complete, closed type-only unit (an omitted dependency is refused, not
  silently added);
- a relative type import inside the promoted declaration (there is no proof
  for where it resolves from the new contract location);
- any consumer whose use of the promoted symbol strays into value space;
- a rewritten consumer that still holds a value-level import of a retained
  root after promotion;
- a rendered app adapter whose exported surface is not exactly its contract's
  declared symbol list (narrower or wider both refuse); and
- an appAdapter declared without a reviewed `template` id, or a `template` id
  with no matching `scaffoldTemplates.extraFiles` entry.

`prepare-audit`'s independent, post-apply re-proofs (`retainedRootClearance`,
`adapterSurfaceParity` in its report) re-run the deletion and adapter-surface
checks against the landed bytes, so a plan-time proof cannot silently go stale
between compilation and apply.

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
      // Optional: `governance/repository.ts` means
      // `app/backend/src/governance/repository.ts` in this tree.
      referenceBase: "app/backend/src",
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
and a matching mode. `referenceBase` optionally gives shorthand tokens an exact
repo-relative resolution base. Shorthand tokens receive the moved file's new
repo-relative path, while tokens beginning with `./` or `../` receive a
canonical replacement relative to the same base. Full repo-relative tokens
continue to work unchanged. Parent traversal is accepted only when normalizing
the token against the base names an exact moved donor inside the real workspace;
absolute paths, lexical workspace escapes, and symlink escapes are refused.
Overlapping roots may not declare different bases, and any direct-versus-based
ambiguity refuses the plan. `exact-path-token` is currently the only mode. Tokens are
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
postJournalPreparers: [
  {
    id: "quality-ratchet",
    phase: "after-journal-before-gates",
    command: "node tools/promote-ratchet.mjs {targetPath}",
    outputs: ["quality/baselines/{targetPath}.json"],
    triggers: ["docs/"], // matches rewritten doc paths
  },
];
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

JSON registries that store module paths relative to a runtime resolver root
need stronger semantics than an ordinary path token. Declare the exact registry,
JSON-pointer pattern, and resolver root; `*` selects array or object entries:

```ts
runtimeModuleRegistries: [
  {
    file: "apps/api/config/route-registry.json",
    pointer: "/domains/*/module",
    resolveFrom: "apps/api/src",
    // The consumer calls value.slice(2) before resolving it.
    stripPrefix: "./",
  },
];
```

Only string values selected by that pointer are eligible. The plan records the
resolved concrete JSON pointer, line, column, resolver root, donor, replacement,
and before/after hashes. A selected value whose raw JSON occurrence is not
byte-unique refuses planning instead of guessing which occurrence to edit.
When `stripPrefix` is declared, every selected value must carry it, the moved
target is rendered with it, and replay re-proves the same strip-then-resolve
semantics. This models consumers that remove a registry marker before `join`;
it is not a general text-rewrite hook.

If rewriting the registry invalidates generated source, compose the registry
declaration with the existing post-journal generator lifecycle. Its trigger is
the registry path, not the moved module path:

```ts
postJournalPreparers: [
  {
    id: "route-stubs",
    phase: "after-journal-before-gates",
    command: "bun apps/api/scripts/route-stubs.ts",
    outputs: ["apps/api/src/routes.ts"],
    triggers: ["^apps/api/config/route-registry\\.json$"],
    verify: "bun apps/api/scripts/route-stubs.ts --check",
    emittedModuleSpecifiers: [{ source: "apps/api/scripts/route-stubs.ts", resolutionBase: "apps/api/src/routes.ts" }],
  },
];
```

`emittedModuleSpecifiers` covers generator/template source that contains a
module specifier which will be emitted verbatim. `resolutionBase` must be one
of the preparer's outputs: the string resolves from that generated module's
directory, not from the generator source. The planner binds each exact quoted
string to one moved donor, derives its destination-relative replacement, and
journals the generator-source rewrite before regeneration. Ambiguous donors,
config drift, source-byte drift, and manifest identity tampering refuse.

The journal rewrites the registry and scaffolds package/dependency state first.
The projected tree then installs or links those dependencies and verifies its
lockfile before the generator runs once for its sorted declared output set.
Its verification, audit, external compilation, and repository gates all see
that same regenerated tree. A current config that declares this trigger while
an older manifest omits it is refused and must be replanned.

A triggered preparer is the sole writer of every declared output. If an output
currently imports a donor, the compiler deliberately omits the ordinary
consumer rewrite and dependency wiring for that file; otherwise the journal
and generator would claim two incompatible final byte states. The regenerated
file is rediscovered by the post-journal graph audit. A generator that leaves
its old donor import stale fails audit rather than being hidden by the ownership
exemption.

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
The refreshed manifest is always a distinct review artifact. Monocarve refuses
in-place replacement and never combines refresh, approval, and application.

Review the manifest before approving it. In particular, review the baseline
commit, every operation and precondition/result hash, target package and
scaffold bytes, consumer rewrites, generated artifacts, rendered gate commands,
the evaluation-effects inventory, and both generated commit subjects. A plan is
an executable, hash-bound review artifact, not a suggestion.

### Provenance and commit metadata

The committed manifest is the provenance record for an extraction; keep it in
history and retain the audit result with the change review. Commit subjects and
bodies are workspace-owned `commitTemplates` policy. The approval commit's
subject must match the rendered `commits.plan` subject; its body is not
evidence, and Monocarve neither adds nor checks an `Extraction-Proof` trailer.
See [Concepts](concepts.md#provenance-lives-in-the-manifest-not-in-commit-trailers).

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

When the reviewed plan is ready to land, use the one-pass landing command,
including the optional package-manager lockfile comparison when the plan has a
lockfile importer:

```sh
bunx monocarve apply --plan .monocarve/plans/c-example123.json --commit --verify-lockfile
bunx monocarve audit --plan .monocarve/plans/c-example123.json
```

`apply --commit` performs the mandatory simulation once, then immediately
applies the identical verified journal. This is the default landing path.

Without `--commit`, `apply` is an evidence-only feasibility or review run. It replays the journal in a
disposable worktree, regenerates configured artifacts, audits that tree, checks
the lockfile when requested, and runs the configured gates. The real checkout
is not changed. Its `transaction.nodeModules` strategy defaults to `symlink`;
`install` and `none` are available for workspaces whose gates need those
strategies. Use this standalone form only when someone must review feasibility
evidence before deciding whether to land. Do not run it immediately before a
committed apply: the committed invocation must simulate again, so that sequence
pays cold setup and repository gates twice. Monocarve does not cache simulation
evidence because safe reuse would need to bind the exact plan, approval,
baseline, configuration, compiler, dependencies, generated outputs, gates, and
execution environment.

After simulation, the committed apply creates up to two commits: the move
commit contains only declared R100 renames; the wiring commit contains
scaffolding, import rewrites, lockfile changes, move-with-rewrite changes, and
regenerated artifacts. Audit the result immediately, before another extraction
changes paths that this plan owns. Audit checks declared byte fidelity,
consumer/boundary and compile evidence, codemod replay, entrypoint closure,
lockfile importer integrity, generated artifacts, and the recorded dynamic
import property. It is not a general proof that application behavior is
unchanged; see [Concepts](concepts.md#audit-proofs) for what each proof does
and does not claim. `status --plan <path>` then reports the lifecycle state and
one safe next command, and `receipt --plan <path> --write` records the passing
audit immutably.

Some repositories attach their full staged Definition of Done to every commit.
For an extraction campaign, if the operator has explicit authorization to defer
that expensive hook, set `SKIP` to that hook's exact identifier for intermediate
commits only. Keep all structural, lint, hygiene, secret, and commit-message
hooks active, record the focused gates, and run the full Definition of Done once
before opening the pull request. Do not use broad `--no-verify` as a performance
shortcut.

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

`--skip-gates` is only for a non-committing, fast journal-and-audit
simulation. The CLI does not currently refuse it together with `--commit`, so
this is an operator rule: never land a plan with `--skip-gates`, because the
repository's gates are the only evidence that the extraction builds and tests.
`transaction.simulateGates: false` is likewise a workspace policy choice; do
not use it as a substitute for validating a production extraction.

### Lockfile verification

Use `--verify-lockfile` for any plan with a lockfile-importer operation when the
package manager is available: it compares the plan's deterministic splice with
what the real package manager writes, and a missing or failing package manager
or any difference fails the simulation. See
[Concepts](concepts.md#audit-proofs) and
[Troubleshooting](troubleshooting.md#lockfile-verification).

## Failure, rollback, and resume

Simulation failures leave the real checkout untouched. The JSON result includes
the failure plus structured `failedGate` evidence: tier, command, exit code,
bounded head and tail excerpts, and a full log path. Full logs live beside the
retained failed simulation worktree under `transaction.worktreeRoot`, so they
do not dirty the gated checkout. They are not secret-redacted; gate commands
must not print credentials. A failed log write is reported as
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

A committing apply also holds a Git-common-dir ownership lock, records its
durable phase, and writes a rollback checkpoint before its first mutation.
`SIGINT`/`SIGTERM` roll back in-process, release the lock, and exit 130/143.
After `SIGKILL`, a lost terminal, or a shell timeout, run `apply-status`; once
the owner is provably stopped, run `apply-recover --plan <path>`. For an owner
stopped mid-journal (phase `applying`) it restores HEAD, the index, and every
journal path from the checkpoint and verifies them, releasing nothing if that
verification fails; otherwise it changes no Git state. Either way it prints the
exact apply argv to run next, adding `--resume` only at the move-commit
boundary. An unparseable lock needs `--force-corrupt-lock`, and only after you
have confirmed no apply is running. Never reset the branch while the owner is
alive. The full state machine is in
[Concepts](concepts.md#apply-checkpoint-and-recovery), and every recovery
refusal is listed in [Troubleshooting](troubleshooting.md#interrupted-apply).

When in doubt, stop after a refusal or failed simulation, inspect `git status`
and the reported plan/worktree, correct the cause, and repeat the safe loop from
plan review. Do not run internal transaction flags or manually stage a partial
journal as a recovery shortcut.

## Where disposable state lives

Simulation worktrees, the external-consumer proof fixture, the preparer
bootstrap index, the config sandbox, and path-migration command directories
live outside the repository, because `apply` refuses a dirty tree. By default
they go under `~/.cache/monocarve/<checkout>-<hash12>/` (or
`$XDG_CACHE_HOME/monocarve/<checkout>-<hash12>/`), where the suffix is the
checkout's basename plus a hash of its realpath, so separate checkouts and
linked worktrees never share a root. `MONOCARVE_SCRATCH_ROOT`, when set to an
absolute path, is used verbatim with no suffix — every checkout using it
shares that root. `transaction.worktreeRoot` overrides the location of
simulation worktrees specifically; use it when simulations need a particular
filesystem (more space, different `noexec` or quota behaviour). The resolution
order and the reasons for avoiding `/tmp` are in
[Concepts](concepts.md#scratch-root).

Interrupted runs leave worktrees behind, since no `finally` survives `SIGKILL`.
Reclaim them with `monocarve prune-worktrees` (default `--older-than 1h`;
`--all` removes every one).
