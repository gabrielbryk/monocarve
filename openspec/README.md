# OpenSpec in this repository

This directory holds monocarve's [OpenSpec](https://github.com/Fission-AI/OpenSpec)
change proposals: a spec-driven workflow for proposing, reviewing, and
archiving behavior changes before or alongside implementation.

## How it works

- `openspec/specs/` holds the current, accepted specification for each area
  of behavior — the source of truth for what monocarve does today.
- `openspec/changes/<change-id>/` holds an in-progress proposal: `proposal.md`
  (why, and what changes), `design.md` for decisions worth recording, and
  `tasks.md` tracking implementation. A proposal is a plan, not implemented
  CLI behavior, until its change lands.
- Once a change ships, `openspec archive <change-id>` moves it under
  `openspec/changes/archive/` and folds its deltas into `openspec/specs/`, so
  the spec directory stays current and the archived change remains as a
  record of the decision.

## Active changes

These are proposals, not implemented CLI behavior. Order reflects rough
dependency, not commitment to build in this sequence.

| Change                                                                                     | Outcome                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`streamline-extraction-workflow`](changes/streamline-extraction-workflow/proposal.md)     | Read-only move guidance and honest working-tree diff review for a user editing their own worktree, without requiring the full transactional path.                                                  |
| [`improve-extraction-readiness`](changes/improve-extraction-readiness/proposal.md)         | Read-only transaction readiness reporting (worktree capability, scratch path, dependency strategy, gate inventory) and phase-level timing/failure attribution for simulation and apply.            |
| [`improve-extraction-correctness`](changes/improve-extraction-correctness/proposal.md)     | An explicit move-set planning route for a reviewed multi-file boundary, plus pre-approval checks for target layout, imports, test consumers, package references, and lockfile importer changes.    |
| [`improve-cli-diagnostics`](changes/improve-cli-diagnostics/proposal.md)                   | Discoverable build/command identity, typed usage errors instead of unhandled exceptions, and bounded, actionable output for large discovery reports.                                               |
| [`provide-monocarve-agent-guidance`](changes/provide-monocarve-agent-guidance/proposal.md) | A distributable agent-skills plugin covering workspace setup, boundary assessment, in-place and transactional extraction, and diagnosis/recovery, version-aware and honest about proof boundaries. |

## Archived changes

`openspec/changes/archive/` contains changes that have already shipped, kept
for their design history. See `openspec/specs/` for the specification they
produced.
