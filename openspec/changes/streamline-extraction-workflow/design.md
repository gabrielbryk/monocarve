## Context

The graph and planner know candidate membership and consumers, while Git shows the user's actual edits. Neither alone proves an in-place extraction is correct. The transaction engine deliberately binds a committed baseline and owns its own writes; an advisory mode must not imply the same guarantee.

## Goals / Non-Goals

**Goals:** Make the current-worktree workflow useful without requiring a plan commit, a managed worktree, or a transaction. Attribute checks to actual evidence. Keep default outputs short and expandable.

**Non-Goals:** Automated in-place mutation, bypassing transactional safeguards, certifying behavioral equivalence, or promising rollback of user edits.

## Decisions

### 1. Provide a distinct advisory command family

Introduce `guide-move` for a selected candidate or explicit source set and `review-diff` for a user-supplied base revision versus the current index and working tree. Names and arguments are illustrative until CLI design review; the capability and evidence semantics are normative. Explicit file selection may include files that are not portfolio candidates, but the report marks missing graph coverage and cannot call them safe candidates. The guide lists exact source-to-target mapping, known consumers, package/export/lockfile wiring, generated files, and configured relevant gates. It never mutates Git or source.

### 2. Review the real state and identify coverage limits

The diff reviewer includes staged, unstaged, and untracked files. It compares moved content, imports, entrypoints, package references, and known boundary edges to the intended move. A check is labeled `passed`, `failed`, or `not-run`; an analysis outside configured graph roots is `unavailable` with a reason. It never labels a manually edited file an R100 move unless its bytes and Git evidence establish that. Report the base revision, dirty state, selected paths, detected consumers, and graph/config identity so the operator can judge freshness.

### 3. Keep checks separate from suggestions

The first slice does not run repository gates. It prints focused commands from workspace configuration as suggestions and records no gate pass claim. A later explicit `--run-gates` extension may run them in the current checkout, but requires a separate design for gate-created files and user changes.

### 4. Make the transactional fast path explicit

The CLI and guide should direct users from reviewed plan to one `apply --commit` call. A standalone `apply` is for separate feasibility review and cannot be treated as a cached prerequisite. Correct the guide's commit-hook claims against the implementation's `--no-verify` behavior.

## Risks / Trade-offs

- A working tree can change during review. Capture and recheck relevant file and index identities; fail as stale when they change rather than publish a mixed report.
- Manual edits may be broader than a planned closure. Report unresolved or uncovered paths, never infer success from a clean subset.
- Running gates in the current checkout may modify user files, so gate execution is deferred.

## Dependencies

Reuse graph, consumer, and boundary analysis. Do not depend on the unmerged architecture-assessment change; integrate its qualified graph evidence later if it lands.
