## Context

`apply --commit` simulates in a disposable worktree before changing the user's checkout. A standalone feasibility apply repeats that setup and its gates if committed apply follows. Dependency setup depends on configured `nodeModules` policy; the current default is `symlink`, so installation is not universal. Gate tiers are ordered and default to one concurrent command.

## Goals / Non-Goals

**Goals:** Fail early on detectable host/configuration blockers, make expensive phases visible, and make replanning reasons intelligible.

**Non-Goals:** Predict gate success, suppress repository gates, automatically refresh approved plans, cache simulation evidence, or weaken exact baseline and approval checks.

## Decisions

### 1. Preflight cheaply before approval

A `readiness` surface accepts a prospective or written plan. It reports whether the configured worktree root can be used under current Git policy, which dependency strategy applies, which package-manager commands would run, and the configured gate tiers and timeouts. It performs bounded disposable probes only when explicitly requested; the default is read-only inspection. A probe removes only its own artifacts and reports any residue. Preflight reports `ready`, `blocked`, or `unknown` per prerequisite and never predicts gate results.

### 2. Separate wall-time diagnostics from plan identity

Record durations around worktree setup, dependency setup, journal, regeneration, audit, postconditions, lockfile comparison, asset proof, each gate, and real-checkout apply. Add a human timeline and structured JSON fields to outcomes. Wall-clock values never enter manifests, plan IDs, or replay hashes. An interrupted run may have incomplete timing and must say so.

### 3. Classify failures at their source

Return a stable phase and cause code with the underlying command/path and bounded log reference where available. A missing type in the simulation worktree is reported as isolated dependency or compiler setup evidence when that is established, not mislabeled as an application regression. Repository-wide boundary failures distinguish pre-existing baseline violations from new violations attributable to the plan; pre-existing findings remain visible and may still block transaction policy.

### 4. Explain baseline drift before recompilation

Enhance existing `refresh` and preflight output to inventory changed plan inputs and distinguish provenance-only changes from semantic changes to moves, consumers, wiring, gates, or generated outputs. A refreshed plan is a new immutable artifact requiring review and approval. The system never substitutes it inside an apply invocation.

## Risks / Trade-offs

- A probe may pass while later environment state changes. Report probe time and scope; repeat hard checks during apply.
- Cost estimates based on prior runs are advisory. Display configured work rather than a fabricated elapsed-time prediction when history is absent.
- Pre-existing boundary errors are real; classification improves attribution without waiving them.

## Dependencies

Uses existing `refresh`, gate diagnostics, worktree configuration, and transaction state. This change can proceed independently of the advisory workflow.
