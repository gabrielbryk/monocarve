## Why

Users often want Monocarve's boundary analysis while editing their existing worktree themselves. The only supported mutating extraction path requires a reviewed manifest commit, disposable simulation worktree, repository gates, and transaction commits. Session reviews found manual moves after candidate mismatch or simulation failure, and repeated feasibility simulation before committed apply. The product needs an honest, lower-process path.

## What Changes

- Add read-only move guidance for selected files or a candidate, including destination layout, consumers, package wiring, risks, and suggested configured checks.
- Add read-only review of the actual working-tree diff, including untracked files, after a user edits or moves files in place.
- Report what was inspected, what remains unverified, and which checks were merely suggested. Do not claim transaction audit, rollback, or gate success.
- Simplify transactional next-step guidance so standalone feasibility simulation is clearly optional and a repeated simulation is identified before it starts.
- Correct hook guidance to match the actual commit implementation.

## Capabilities

### New Capabilities

- `in-place-extraction-guidance`: Advisory guidance and diff review for work already performed in the user's checkout.

### Modified Capabilities

None. The existing transaction contract remains unchanged.

## Impact

New read-only CLI surfaces, diff analysis, operator documentation, and agent-facing guidance. No extraction manifest, approval, apply, audit, rollback, guarded-branch, or deterministic-plan semantics change.
