# Getting started

In this tutorial you extract one feature out of a small application and into a
new workspace package. Every step is one Monocarve command. For each step, the
tutorial explains what the command proves and what to do if it refuses.

The example workspace has the same layout as
[`fixtures/basic-monorepo`](../fixtures/basic-monorepo/). It is a pnpm and moon
workspace with a `web` application, whose chart widget you will move into
`libs/chart`. To follow along, copy that fixture into a new directory, delete
its `monocarve.config.json` (you will write a TypeScript config instead), and
make it a git repository:

```sh
cp -r fixtures/basic-monorepo ~/demo && cd ~/demo
rm monocarve.config.json
printf 'node_modules/\n' > .gitignore
git init -b main && git add -A && git commit -m "chore: initial"
```

## 1. Install

Monocarve is not on npm yet. Link it from a checkout, as described in the
[README](../README.md#install):

```sh
bun link monocarve
bunx monocarve --version
```

After the package is published, `bun add --dev monocarve` will replace this
step.

## 2. Write `monocarve.config.ts`

Monocarve assumes nothing about your workspace. Every convention it relies on
comes from the config: where applications live, which package manager and task
runner you use, what a new package looks like, and which commands gate a
change. Create `monocarve.config.ts` at the workspace root:

```ts
import { defineConfig } from "monocarve/config";

export default defineConfig({
  applications: [
    {
      name: "web",
      sourceRoot: "apps/web/src",
      tsconfig: "apps/web/tsconfig.json",
      packageName: "@acme/web",
      project: "web",
      compositionRoots: ["apps/web/src/main.ts"],
    },
  ],
  packageRoots: ["libs"],
  packageScope: "@acme/",
  packageManager: "pnpm",
  taskRunner: "moon",
  guardedBranches: ["main"],
  testKinds: { unit: ["\\.test\\.tsx?$"] },
  assetExtensions: [".css"],
  gates: { package: ["test -d {packageRoot}"], workspace: ["sh scripts/check-module-ledger.sh"] },
  generatedArtifacts: {
    artifacts: [
      { path: "generated/module-ledger.json", source: "apps/web/src", regenerate: "sh scripts/module-ledger.sh", triggers: ["^apps/web/src/widgets/"] },
    ],
  },
  commitTemplates: { move: "refactor({package}): move {fileCount} files into {packageRoot}", wiring: "refactor({package}): wire {package} into the workspace" },
  portfolio: { minFiles: 1 },
  scaffoldTemplates: {
    entrypoint: "src/index.ts",
    packageJson: {
      contents:
        '{\n  "name": "{package}",\n  "version": "0.0.0",\n  "private": true,\n  "type": "module",\n  "main": "./{entrypoint}",\n  "types": "./{entrypoint}"\n}\n',
    },
    tsconfig: { contents: '{\n  "extends": "{relativeRoot}/tsconfig.base.json",\n  "include": ["src/**/*"]\n}\n' },
    taskFile: { contents: "$schema: 'https://moonrepo.dev/schemas/project.json'\ntype: 'library'\nlanguage: 'typescript'\nid: '{project}'\n" },
  },
  transaction: { nodeModules: "none" },
});
```

Some of these fields need more explanation:

- `compositionRoots` lists the entrypoints and DI wiring that must never leave
  the application.
- `testKinds.unit` and `assetExtensions` have no defaults. Without them, the
  chart's test and its CSS file would not travel with it.
- `gates` are your repository's own checks, run in tiers. These examples are
  trivial shell commands. In a real workspace you would put your lint,
  typecheck, and test commands here. Monocarve never invents a gate.
- `generatedArtifacts` declares a generated file that the move makes stale.
  Monocarve regenerates it during simulation and apply.
- `scaffoldTemplates.packageJson` is required. Monocarve has no built-in
  package layout.
- `transaction.nodeModules: "none"` is set because this example has no
  installed dependencies. The default is `symlink`.

Every field is described in the [configuration reference](configuration.md).
Commit the config and switch to a feature branch. `apply --commit` refuses to
commit on a branch listed in `guardedBranches`.

```sh
git add monocarve.config.ts .gitignore && git commit -m "chore: add monocarve config"
git switch -c extract-chart
```

## 3. `config-doctor`: check what the tool sees

```sh
bunx monocarve config-doctor
```

This command reads your config and the workspace and changes nothing. The
report includes the resolved config path and root, the effective settings,
the workspace packages it found, adapter availability (`"status": "available"`
for pnpm and moon), dirty paths, and any `semanticIssues`.

**If it refuses:** `no config found in … or any parent directory` means that
discovery walks up from the current directory looking for
`monocarve.config.{ts,mts,js,mjs,json}`. Run the command from inside the
workspace, or pass `--config <path>`. An `invalid config at …` message names
each failing field path. A value such as `packageManager: "npm"` fails with
`npm is not supported yet; supported package managers: pnpm, bun`.

## 4. `scan` and `portfolio`: find a candidate

```sh
bunx monocarve scan --app web
bunx monocarve portfolio --app web
bunx monocarve candidates --app web
```

`scan` builds the dependency model and reports module, edge, and SCC counts
together with the commit it describes. It is cached by tree hash, so later
commands reuse it. `portfolio` groups the model into candidates. A candidate is
the SCC closure of a seed module: the seed, everything it transitively imports
inside the application, its tests, and its assets. `portfolio` then applies
eligibility rules and ranks the candidates.

By default `portfolio` lists only candidates it _recommends_. Its `totals`
always count the whole population. If `top` is empty but `totals.eligible` is
not zero, the eligible candidates were ranked `discouraged`, often because no
`portfolio.domains` are configured. List them with
`portfolio --recommendation all`, or use the table view:

```text
ID              STATE     CLASS       RECOMMENDATION  SCORE  LOC  PATHS  TARGET
c-59e19478e70b  eligible  extraction  discouraged     41     6    1      @acme/root
c-09d8a524b603  eligible  extraction  discouraged     -738   19   4      @acme/root
c-24422bfdb05c  blocked   extraction  discouraged     ...
```

`c-09d8a524b603` is the chart closure: `chart.ts`, its test, `chart.css`, and
the `types.ts` it imports. Candidate ids are derived from the closure, so
always use the id your own run prints. `candidates --candidate <id> --json`
shows the full closure, its blockers, and the target options.
`backlog` explains blocked candidates and names the concrete edges you would
have to break.

## 5. `plan`: compile the extraction

```sh
bunx monocarve plan --candidate c-09d8a524b603 --package-name @acme/chart --write
```

`plan` writes `.monocarve/plans/c-09d8a524b603.json` and does not touch any
source file. The manifest records the baseline commit and the source blob
hashes. It also holds an ordered journal of operations (`move`,
`rewrite-import`, `write-file`, `lockfile-importer`, and others), each with a
precondition hash and a result hash. Its provenance records the config digest
and compiler identity (see [Concepts](concepts.md#plan-identity)). Because
`@acme/chart` does not exist yet, the target mode is `new` and the package is
scaffolded from your templates. If you name an existing package, the plan
extends that package instead.

**If it refuses:**

- `refusing to plan from a dirty working tree: <paths>`: commit or stash those
  paths. `transaction.allowDirtyPaths` may list unrelated paths only.
- A candidate that is not eligible is refused. `--force` bypasses portfolio
  eligibility only. Validation, simulation, and audit still apply.
- `plan --write` refuses to overwrite an existing manifest. To recompile after
  `HEAD` has moved, use `refresh`.

## 6. Review and approve

```sh
bunx monocarve plan-review --plan .monocarve/plans/c-09d8a524b603.json
```

```text
Plan c-09d8a524b603
Target: @acme/chart (new) at libs/chart
Moves: 4
  apps/web/src/types.ts -> libs/chart/src/types.ts
  apps/web/src/widgets/chart.ts -> libs/chart/src/widgets/chart.ts
  apps/web/src/widgets/chart.test.ts -> libs/chart/src/widgets/chart.test.ts
  apps/web/src/widgets/chart.css -> libs/chart/src/widgets/chart.css
Operations: move=4, ..., rewrite-import=1, write-file=6, lockfile-importer=2
Consumers: 1
  apps/web/src/main.ts (runtime) -> @acme/chart, @acme/chart
Generated outputs: 1; scaffold outputs: 4
Gates: package=1, project=0, workspace=1
Approval: chore(@acme/chart): compile extraction plan c-09d8a524b603 @ .monocarve/plans/c-09d8a524b603.json
```

Read the warnings as well. For example, `evaluation-effects` means that
importing the new package runs top-level code that consumers did not
previously evaluate. The manifest is an executable review artifact. Approving
it approves every hash, target path, rewrite, and gate command in it.

Approval is a commit that contains only the manifest, with the rendered plan
subject:

```sh
bunx monocarve approve --plan .monocarve/plans/c-09d8a524b603.json          # preview
bunx monocarve approve --plan .monocarve/plans/c-09d8a524b603.json --commit
bunx monocarve verify  --plan .monocarve/plans/c-09d8a524b603.json
```

`verify` is read-only. It checks the manifest's structure and semantics, the
journal preconditions, a clean checkout, the branch policy, and that `HEAD`
equals the baseline plus exactly the approval commit. A passing result has
`"validation": { "ok": true }` and no `blockers`.

**If it refuses:** `approve --commit` refuses staged or unrelated dirty paths
and guarded branches. If `verify` reports
`[compiler-integrity] plan compiler identity does not match this compiler`,
the Monocarve build changed after you compiled the plan. See
[Troubleshooting](troubleshooting.md#stale-plan-config-digest-or-compiler-identity-mismatch).

## 7. Simulate and apply

```sh
bunx monocarve apply --plan .monocarve/plans/c-09d8a524b603.json --commit
```

`apply --commit` is the normal way to land a plan. It first simulates: it
creates a disposable git worktree at the baseline, replays the journal,
regenerates `generated/module-ledger.json`, audits that tree, and runs your
gates in package, project, and workspace order. Only if all of that passes
does it replay the identical journal in your checkout, producing two commits:

```text
refactor(@acme/chart): wire @acme/chart into the workspace   # 9 files: scaffold, import rewrite, lockfile, ledger
refactor(@acme/chart): move 4 files into libs/chart          # 4 pure renames (R100)
chore(@acme/chart): compile extraction plan c-09d8a524b603   # your approval
```

`apply` without `--commit` runs the same simulation and leaves your checkout
unchanged. Use it when someone must review feasibility evidence before
deciding to land. Don't run it just before `apply --commit`, because the
committing run always simulates again.

**If it refuses or fails:**

- A gate failure stops before your checkout is touched. The result includes
  `failedGate` (tier, command, exit code, output excerpts, `logPath`) and
  `gateRetry`, which gives the exact cwd and command inside the retained
  worktree.
- `refusing to commit on the guarded branch main`: switch to a feature branch.
- An interrupted apply (Ctrl-C, a killed terminal): run `apply-status`, then
  `apply-recover --plan <path>`. See
  [Troubleshooting](troubleshooting.md#interrupted-apply).

## 8. Audit

```sh
bunx monocarve audit --plan .monocarve/plans/c-09d8a524b603.json
bunx monocarve status --plan .monocarve/plans/c-09d8a524b603.json
```

`audit` checks the landed tree against the manifest. Each proof reports
`passed` separately: `byteFidelity`, `consumerCompleteness`, `boundaryRules`,
`externalConsumerCompile`, `codemodReplay`, `entrypointClosure`,
`lockfileIntegrity`, `generatedArtifacts`, `sourceConservation`, and graph
evidence. Run the audit right after apply. It checks the tree exactly as this
plan left it, so a later extraction that touches the same paths will make it
fail.

`status` is read-only. It confirms the approval, move, and wiring chain,
re-audits, and prints the single safe next command. If you want an immutable
record of the passing audit, `receipt --plan <path>` previews one and
`--write` creates it.

## Where to go next

- [Concepts](concepts.md) explains the model behind each step.
- The [operator guide](operator-guide.md) covers extending existing packages,
  refreshing stale plans, declaration preparation, boundaries, and campaigns.
- [Troubleshooting](troubleshooting.md) lists refusals and their fixes.
- To explore the dependency graph in a browser, run `bunx monocarve visualize`.
  It serves a loopback-only interactive UI. Pass `--no-open` on a remote
  host.
