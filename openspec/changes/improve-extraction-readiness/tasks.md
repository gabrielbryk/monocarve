## 1. Early readiness

- [ ] Define prerequisite codes and read-only readiness output for a prospective or written plan.
- [ ] Add an opt-in bounded worktree probe that respects Git wrapper policy and owns its cleanup.
- [ ] Report dependency strategy, lockfile prerequisites, gate commands, tiers, concurrency, and timeouts.
- [ ] Add negative cases for blocked worktree creation, missing dependencies, and probe residue.

## 2. Runtime diagnosis

- [ ] Instrument transaction phases without changing manifest serialization or plan IDs.
- [ ] Categorize failure phase and source, preserving exact command, bounded output, and log path.
- [ ] Identify pre-existing versus introduced repository-wide boundary findings.
- [ ] Add negative cases proving each classification fails on a plausible wrong attribution.

## 3. Baseline explanation and guidance

- [ ] Extend refresh/preflight output with changed-input and semantic-diff categories.
- [ ] Keep refreshed manifests immutable and separately approved.
- [ ] Document the one-pass apply path and explain when standalone simulation repeats work.
