---
name: extraction-efficiency
description: Execute a Monocarve extraction with readiness checks, bounded iteration, explicit process supervision, and one final full validation. Load when planning, preparing, applying, or recovering an extraction campaign.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
ops-risk: write
---

# Extraction efficiency

Use Monocarve for the structural extraction and its proofs. Do not turn every prerequisite edit into a transaction. The goal is one ready baseline, one immutable extraction plan, one apply, and one final full gate.

## Establish authority first

Before editing, record:

- the requested source boundary and destination owner;
- whether existing consumer imports may change;
- whether temporary compatibility exports are required;
- whether overlapping branches are acceptable or must be avoided;
- the repository's focused gates and final Definition of Done;
- the exact baseline commit and clean-worktree state.

Treat those choices as campaign inputs. Do not invent conflict-avoidance work after the user has accepted later merge conflicts. Do not introduce a compatibility layer unless the requirement calls for one.

## Choose the smallest truthful mechanism

Use this decision tree for every change discovered before extraction:

1. Is it the cohesive file move, import rewrite, package wiring, or conservation proof?
   - Yes: include it in the actual Monocarve extraction.
2. Is it a small, independently reviewable readiness correction whose desired bytes are already clear?
   - Yes: make a direct scoped prerequisite commit, run focused proof, and rescan from that new baseline.
3. Does the prerequisite require deterministic generation, coordinated changes across many files, or a reusable transformation whose replay/audit proof matters independently?
   - Yes: use a preparer.
4. Is the correction merely a manifest spelling, declared output, stable anchor, or other mechanical plan-authoring error with no semantic or scope choice?
   - Yes: correct it autonomously and revalidate.
5. Does the failure change behavior, ownership, public API, scope, security, data semantics, or a tool invariant?
   - Yes: stop and obtain a decision.

Never use a preparer solely to avoid making a one-line or similarly bounded prerequisite commit. Never bypass Monocarve for the extraction itself.

## Destination-readiness preflight

Run this before approving an extraction plan. Inspect both moved files and the destination package as they will exist after the move.

- **Strict TypeScript:** compile under the destination configuration. Check optional-property construction, `undefined` handling, module mode, JSX settings, path aliases, and declaration emission.
- **Lint ownership:** lint the exact files that will move. Existing debt becomes owned when those files are touched; surface it before commit hooks do.
- **Test scaffold:** inventory setup files, DOM matchers, environment declarations, test-only helpers, router/provider harnesses, and their runtime and type dependencies.
- **External declarations:** resolve each external import under the destination module mode. Include adjacent declaration forms and package `exports` conditions; fail on mismatched runtime and declaration targets.
- **Package truth:** verify runtime versus development dependencies, peer dependencies, exports, project registration, and consumer-facing entrypoints.
- **Generator triggers:** list every post-journal generator the planned paths activate and the files each may write. Classify output as causal, pre-existing drift, or an unexpected scope expansion.
- **Consumer behavior:** confirm eager versus lazy loading, dynamic-import chunking, public symbols, tests that should travel, and consumers that intentionally remain behind compatibility exports.
- **Resource capacity:** check scratch location, free bytes, and free inodes. Prefer a workspace or user-cache scratch directory when configurable; do not place dependency trees or build outputs in memory-backed temporary storage.

Resolve readiness failures with the decision tree above. Then commit prerequisites, require a clean worktree, rescan, and compile the immutable plan. Do not approve a plan against transient dirty state.

## Execute one supervised transaction

1. Review scope, baseline, destination, journal, gates, and generated outputs.
2. Approve exactly one immutable plan.
3. If the next intended action is landing, run `apply --commit` directly. It performs the mandatory simulation once and then applies the identical verified journal.
4. Run standalone `apply` without `--commit` only when feasibility evidence must be reviewed before landing, policy explicitly requires a separate review boundary, or the operator does not yet intend to mutate the checkout. Never run it merely as a prelude to an immediate committed apply: the committed invocation must simulate again and Monocarve intentionally does not cache that evidence.
5. Apply once. Do not launch an overlapping retry.
6. Audit and verify the terminal result, including source conservation, import direction, package boundaries, and commit partitioning.
7. Run focused package and consumer gates during iteration.
8. Run the repository's full Definition of Done once after the extraction unit is complete.

If a repository's commit hook invokes its full staged Definition of Done on every intermediate extraction commit, and the user or repository policy explicitly authorizes bypassing that hook for the campaign, skip only that named hook for intermediate commits (for example, `SKIP=<full-gate-hook-id> git commit ...`). Keep structural, lint, hygiene, secret, and commit-message hooks enabled; record the focused gates run for each commit; and run the full Definition of Done once before the PR. Never use broad `--no-verify` for this optimization.

### Simulation decision

- **Ready and landing now:** `apply --commit`. One invocation, one mandatory simulation, then commit.
- **Evidence-only review or uncertain landing:** standalone `apply`. Stop after it and review; accept that a later committed apply will simulate again.
- **Trying to save time by skipping proof:** refused. Do not use `--skip-simulation`, stale receipts, or manual journal replay.

Simulation receipt reuse is deliberately deferred. Safe reuse would have to bind the exact plan and approval bytes, baseline and checkout state, configuration and compiler identity, dependency installation, generated outputs, gate commands, and relevant execution environment. Reusing less evidence could land a journal that was not the one actually proved.

### Process supervision

A wrapper yielding control is not a terminal result. For every long-running command:

- retain its real session identifier;
- confirm the live child process or process ancestry;
- poll that session until an explicit exit code is observed;
- record the current phase and most recent output;
- do not infer success from silence or from the wrapper returning early;
- do not start a retry while the original process or a child remains alive.

Use milestones: readiness complete, prerequisite commit, fresh scan, plan compiled, plan approved, apply terminal, audit terminal, focused gates, full gate. Report at transitions. If a command has no new output, inspect liveness before deciding it is stuck. Set a campaign-specific no-progress timebox based on the expected command; stop only after confirming both elapsed time and absent progress.

## Failure handling

Classify the first failure before acting:

| Class                | Examples                                                                                        | Response                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Mechanical authoring | Missing declared output, stale hash after an intentional prerequisite, exact anchor mismatch    | Correct autonomously, regenerate from the clean baseline, and revalidate                             |
| Readiness            | Strict-type error, lint debt, missing test scaffold dependency, unresolved external declaration | Land the smallest scoped prerequisite or use a justified preparer, then rescan                       |
| Environmental        | Inode exhaustion, missing executable, unavailable cache, killed child                           | Stop the process, preserve state, repair capacity or environment, then make one controlled retry     |
| Generator noise      | Unrelated global artifact or pre-existing drift appears                                         | Prove the trigger and causality; exclude or restore unrelated output without weakening the generator |
| Semantic or scope    | Public API changes, new compatibility policy, changed runtime behavior, expanded destination    | Stop and request a decision                                                                          |
| Invariant or proof   | Partial application, non-determinism, impure move commit, conservation or audit failure         | Stop; diagnose the tool or plan. Never work around the proof                                         |
| Monitoring ambiguity | Yielded session, silent command, uncertain exit                                                 | Inspect the actual session and process ancestry; do not diagnose product or tool behavior yet        |

Stop at the first real failure. Do not stack speculative fixes. A retry must have one identified cause, evidence that the cause is removed, and confirmation that no prior process is live.

## Time and work limits

Track elapsed time by phase, not only total runtime. Useful campaign metrics are:

- number of prerequisite commits and why each was not part of the extraction;
- plans compiled and plans approved (normally one approved plan);
- apply attempts and causes of any retry;
- time spent in readiness, planning, apply, audit, and gates;
- production and test files or lines moved;
- focused gate duration versus final full-gate duration;
- pauses caused by semantic decisions versus mechanical corrections.

Escalate when setup and lifecycle time materially exceeds the expected extraction time. Revisit the mechanism decision instead of repeating the same lifecycle.

## Anti-patterns

- Compiling a preparer for every trivial source correction.
- Approving before destination typecheck, lint, and test-scaffold readiness.
- Treating a yielded wrapper as a completed child process.
- Starting a second apply because the first is quiet.
- Running standalone `apply` and then immediately running `apply --commit`, paying for the same cold setup and gates twice.
- Using broad `--no-verify` when only an explicitly authorized full-gate hook needs deferral until the final PR proof.
- Running the entire workspace gate after every small edit.
- Investigating a tool defect before ruling out process, environment, and destination-readiness failures.
- Letting global generator output silently expand the extraction.
- Designing compatibility shims or conflict avoidance without an explicit requirement.
- Reusing an approved plan after changing its baseline or prerequisite bytes.
- Weakening audits, baselines, or invariants to make an extraction pass.

## Completion evidence

Hand off the baseline and final commit, moved boundary, destination entrypoint, plan identity, terminal apply result, audit and verification results, focused gates, final full gate, remaining compatibility surface, and any accepted merge conflicts. State retries and their causes. A clean worktree and explicit terminal exits are part of the evidence.
