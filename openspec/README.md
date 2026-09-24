# Monocarve improvement scope

These changes turn observed agent usage friction into separable product work. They are proposals, not implemented CLI behavior.

The user selected `streamline-extraction-workflow` as the first implementation target. Its first slice is read-only move guidance followed by review of the actual diff in the existing worktree; it does not require transaction setup.

| Order | Change                             | User outcome                                                                                          | Dependency                                                               |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1     | `streamline-extraction-workflow`   | Move files in the current worktree with useful Monocarve guidance and honest diff review              | Existing graph and consumer analysis                                     |
| 2     | `improve-extraction-readiness`     | Detect host/setup blockers early and see where transaction time went                                  | Existing transaction diagnostics                                         |
| 3     | `improve-extraction-correctness`   | Plan an intentional multi-file boundary and reject bad target/consumer/package wiring before approval | Reconcile already landed planner fixes first                             |
| 4     | `improve-cli-diagnostics`          | Understand wrong manifest, command, path, and candidate errors immediately                            | Coordinate identity and empty-scan behavior with architecture assessment |
| 5     | `provide-monocarve-agent-guidance` | Install concise skills that select and execute the appropriate workflow                               | Ship against actual CLI capabilities; update as changes land             |

## Existing parallel scope

`add-architecture-assessment` is already scoped in the separate `spec/architecture-assessment` worktree. It owns nested workspace-glob qualification, executable identity, unexpected empty scans, read-only architecture assessment, bounded evidence bundles, and batch declaration analysis. Its source and OpenSpec artifacts were uncommitted when this scope was prepared. Do not reimplement those features from this index or treat them as shipped.

## Decision boundaries

- The in-place path is advisory in its first slice. Automated in-place mutation would need a separate decision about rollback and generator/gate side effects.
- The existing transactional path retains deterministic plans, exact approval, no partial journal application, pure R100 move commits, repository-owned simulation gates, and guarded branch refusals.
- Transcript findings are evidence of friction, not proof that every historical bug remains in the current code. Correctness work starts by reproducing remaining defects on the current checkout.
- Workspace-specific values belong in workspace configuration. Specs and examples use synthetic identities only.

## Completion criteria

For each change: complete its tasks, add a negative case for every new proof, document the evidence limit, and validate the relevant OpenSpec change. Implementation verification follows the repository contract when implementation is requested.
