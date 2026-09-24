## 1. Advisory guidance

- [ ] Define stable input/output types and CLI surface for selected files and candidates.
- [ ] Report exact destination, consumer, wiring, generated-artifact, and configured gate guidance with graph coverage limits.
- [ ] Add synthetic examples and negative cases for missing source, unsupported destination, and stale graph inputs.

## 2. Working-tree review

- [ ] Capture staged, unstaged, and untracked changes against an explicit base revision without modifying the checkout.
- [ ] Inspect consumer rewrites and package boundaries; classify each check as passed, failed, not-run, or unavailable.
- [ ] Detect relevant file/index changes during review and refuse mixed-baseline evidence.
- [ ] Add negative cases for omitted consumer, uncovered source, changed bytes, and concurrent worktree mutation.

## 3. Workflow clarity

- [ ] Show one-pass transactional apply as the normal transaction path and warn before duplicate standalone simulation.
- [ ] Correct the operator guide's hook behavior and document the advisory evidence limit.
- [ ] Verify CLI help and documentation refer to the same command contract.
