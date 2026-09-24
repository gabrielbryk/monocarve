## Why

Transcript reviews found approved plans failing before their first gate because simulation could not create a worktree or resolve dependencies. Others spent time on repeated installs, sequential gates, baseline churn, and unclear failure attribution. Operators need cheap readiness evidence and actual phase timing before committing to an expensive transaction.

## What Changes

- Add a read-only transaction readiness report before approval: Git worktree capability, scratch path, dependency strategy, lockfile prerequisites, gate inventory, and estimated work classes.
- Add phase durations and categorized failures to simulation and apply results, without putting clocks into deterministic plans.
- Improve stale-plan and refresh diagnostics with exact changed inputs and a reviewable semantic diff.
- Distinguish setup, journal, audit, repository postcondition, generator, lockfile, gate, and timeout failures.

## Capabilities

### New Capabilities

- `transaction-readiness`: Cheap preflight and cost visibility for the existing transaction path.

### Modified Capabilities

None. Approval and apply authority remain exact.

## Impact

CLI reporting, simulation instrumentation, refresh diagnostics, documentation, and bounded preflight probes. No new gate, relaxed branch rule, silent reapproval, or simulation-cache claim.
