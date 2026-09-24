## Context

The repo currently has a local extraction-efficiency skill, while agent sessions often reach for a built artifact, source CLI, or workspace command with different behavior. A plugin should expose durable source-owned skills and reference the version of Monocarve actually executed. The plugin cannot repair an unsupported workspace or declare an extraction complete from a passing scan.

## Goals / Non-Goals

**Goals:** Reduce repeated command discovery and operator mistakes; route agents to the least costly workflow that meets the requested evidence level; surface exact blockers and next actions.

**Non-Goals:** Auto-approve a plan, silently install dependencies, mutate a repository during read-only assessment, or make plugin prose an alternative to CLI proof.

## Decisions

### 1. One routing skill, focused task skills

The entrypoint asks the agent to choose among read-only assessment, manually edited in-place move, or transactional apply based on user intent. Focused skills cover config/readiness, assessment, in-place review, transaction landing, and failure diagnosis/recovery. Each skill has a short trigger, prerequisites, minimal command sequence, interpretation rules, and explicit completion evidence.

### 2. Bind examples to the installed CLI

Before using workflow-specific flags, the skill confirms executable identity and command help from the selected build. It reports version skew or missing command discovery, and does not assume a global `monocarve` executable. Workspace-specific package names, paths, gates, and branch rules come only from the target workspace config. Examples use synthetic `@acme` identities.

### 3. Prefer one-pass workflows and honest status

Transactional guidance uses review and approval followed by one committed apply and audit; standalone simulation is offered when separate feasibility evidence is actually needed. In-place guidance treats working-tree review as advisory. Assessment guidance refuses implausible empty scans and records qualification limits. Recovery guidance uses transaction status and exact safe commands rather than resetting a branch opportunistically.

### 4. Source ownership and distribution

Plugin files live in a source-owned plugin tree with a documented install path and versioned metadata. Repo-local skill text may point to the plugin but must not create divergent instructions. Installation must not edit deployed cache copies. The plugin should work for Codex and Claude where their documented plugin/skill formats permit, with provider-specific shims kept thin.

## Risks / Trade-offs

- CLI changes can stale examples. Link skills to help and add a documentation consistency check during packaging.
- Too many skills recreate process overhead. Keep the entrypoint small and invoke focused skills only for the selected workflow.
- Workspace-specific advice can leak private conventions into a public plugin. Use config-driven wording and synthetic fixtures.

## Dependencies

The plugin can ship an initial version for current CLI behavior. Update its in-place and readiness skills when the corresponding new commands land; do not advertise unimplemented commands as available.
