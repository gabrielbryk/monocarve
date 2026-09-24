### Reviewed boundary baseline

The post-apply audit proves that no package-owned file imports application
code. That proof is repository-wide, and a workspace part-way through a
decomposition usually already violates it somewhere the plan never touches.
Rather than weaken the proof with a flag, each plan records the violating edges
that already exist at its baseline commit:

- `plan`, `scope`, `next`, `evacuate` and `consolidate` record
  `boundaryBaseline` — a sorted, deduplicated, digested list of
  `file -> imported application file` pairs — into the immutable manifest;
- `plan-review` prints the count, the digest prefix, and every edge, and raises
  the `boundary-baseline-recorded` warning: approving the plan approves them;
- `audit` fails on every violation edge _outside_ that list and reports the
  recorded ones under `boundaryBaseline` as `observed` (still present) or
  `cleared` (removed by this transaction). `boundaryRules` still fails on
  anything new.

The set cannot drift after approval: the approval commit covers the manifest
bytes, a plan applies only at its own baseline commit, and moving to a newer
`HEAD` means `refresh`, which recompiles the baseline and shows any change in
its semantic diff. A manifest with no `boundaryBaseline` — anything compiled
before this existed — is read as an empty baseline, so it still fails on every
violation edge.
