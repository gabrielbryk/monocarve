### Preparer configuration

Preparers are generic repository-owned pre-extraction policies. Each config
entry declares an `id`, `phase: "pre-extraction"`, one or more of `replacements`,
`creates`, and `command`, output path templates, an optional `verify` command, and commit
metadata. Templates may use `{app}`,
`{package}`, `{packageRoot}`, `{planId}`, `{sourcePath}`, and `{targetPath}`;
the last two come from one exact byte-identical move in the extraction
manifest. Planning refuses undeclared writes and non-UTF-8 output files.

```ts
preparers: [
  {
    id: "quality-ratchet",
    phase: "pre-extraction",
    command: "node tools/promote-ratchet.mjs {targetPath}",
    outputs: ["quality/baselines/{targetPath}.json"],
    verify: "node tools/check-ratchet.mjs {targetPath}",
    commit: { subject: "chore: promote ratchet for {targetPath}" },
  },
];
```

For a source edit that does not need a repository helper, declare ordered text
replacements instead:

```ts
preparers: [
  {
    id: "tighten-widget-limit",
    phase: "pre-extraction",
    replacements: [{ path: "{sourcePath}", prefix: "export const widget = { ", before: "limit: 10", after: "limit: 20", suffix: " };" }],
    outputs: ["{sourcePath}"],
    commit: { subject: "refactor: tighten widget limit" },
  },
];
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
preparers: [
  {
    id: "add-widget-contract",
    phase: "pre-extraction",
    creates: [{ path: "{packageRoot}/src/widget-contract.ts", contents: "export interface WidgetContract {}\n" }],
    commit: { subject: "refactor: add widget contract" },
  },
];
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
declares `phase: "after-journal-before-gates"`, exact outputs, optional ordered
anchored `replacements`, optional exact `creates`, an optional command, move-path
triggers, and an optional verification command. Declarative edits use the same
unique framed-state, sequential-chain, terminal-state, and idempotence rules as
pre-extraction preparers. Their fixed order is replacements, creates, command,
then verify. Outputs are
recorded in the extraction manifest, regenerated before audit and gates, and
included in the wiring commit. Undeclared repository changes still fail the
changed-scope audit.

```ts
postJournalPreparers: [
  {
    id: "module-registry",
    phase: "after-journal-before-gates",
    replacements: [
      {
        path: "tools/module-registry.ts",
        prefix: "export const modules = [",
        before: '"apps/api/src/domain.ts"',
        after: '"libs/domain/src/domain.ts"',
        suffix: "] as const;\n",
      },
    ],
    creates: [{ path: "tools/generated-input.ts", contents: "export {};\n", mode: 0o644 }],
    command: "bun tools/generate.ts",
    outputs: ["tools/module-registry.ts", "generated/baseline.ts"],
    triggers: ["^apps/api/src/domain\\.ts$"],
    verify: "bun tools/generate.ts --check",
  },
];
```

Created paths are outputs automatically and must not also appear in `outputs`.
Replacement paths must appear in `outputs`. The immutable manifest records the
full policy and exact before/result hashes and modes. Declarative paths may not
collide with journal operations or emitted-module-specifier sources; planning
refuses instead of relying on an implicit ordering.

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
