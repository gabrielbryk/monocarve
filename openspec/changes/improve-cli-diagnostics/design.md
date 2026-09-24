## Context

The CLI accepts several manifest families and many discovery commands. Transcript reviews show invocation errors amplified by source/built version skew and hard-to-skim outputs. The separate architecture-assessment change already scopes executable identity, nested workspace globs, and suspicious empty scans; this change consumes those results if merged.

## Goals / Non-Goals

**Goals:** Replace opaque failures with typed, actionable diagnostics and keep ordinary output navigable.

**Non-Goals:** Accepting unsafe filesystem paths, auto-detecting a different command after an error, silently migrating old manifests, or changing assessment qualification semantics.

## Decisions

### 1. Validate artifact kind before dereference

Commands that accept a plan inspect version and manifest family before accessing family-specific fields. An incompatible or legacy artifact returns an error naming the expected and observed families and the appropriate command or migration status. Unknown structures fail closed. The error is also available as stable JSON.

### 2. Make path and selection errors actionable

For output paths outside the allowed workspace, name the workspace-relative requirement and show a safe example without printing sensitive absolute paths unnecessarily. For candidate ID versus package-name confusion, identify the argument position and available lookup command. Suggestions never cause an implicit retry or expansion of scope.

### 3. Keep discovery summaries bounded

Human output starts with totals, qualification, top entries, omissions, and exact commands for full JSON/detail. JSON retains stable complete schema or explicit pagination/limit metadata; truncation must be visible. Avoid returning an unexplained zero-module success when qualification is available from the assessment change.

## Risks / Trade-offs

- Too many suggestions can obscure the actual error. Lead with the failing condition and one next action.
- Manifest families may evolve. Centralize classification and keep unknown versions explicit.
- A summary can hide useful candidates. Always report totals and how to get the complete output.

## Dependencies

Executable identity and empty-scan qualification are owned by `add-architecture-assessment` in a separate worktree. This change must integrate with that capability after it lands, or limit itself to current identity fields without inventing a second system.
