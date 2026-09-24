## ADDED Requirements

### Requirement: The plugin routes to the requested evidence level

The plugin SHALL provide an entrypoint and focused skills for read-only assessment, in-place manual extraction, and transactional extraction. It SHALL recommend the workflow whose guarantees match the user's stated intent and SHALL state the evidence and costs of that route. It SHALL NOT silently choose transactional apply when the user requests only guidance or an in-place edit.

#### Scenario: Developer wants to edit an existing worktree

- **WHEN** the developer states they will move files manually in their current checkout
- **THEN** the plugin guides analysis and diff review without requiring a managed worktree or manifest approval commit

#### Scenario: Developer requests rollback-capable automation

- **WHEN** the developer requests the transaction's replay and rollback guarantees
- **THEN** the plugin guides exact review, approval, one committed apply, and audit

### Requirement: Guidance matches the available executable

The plugin SHALL identify the executable and inspect available command help before instructing agents to use version-sensitive flags. It SHALL report missing command discovery or build mismatch and SHALL NOT treat a successful empty scan as trustworthy without source-coverage qualification.

#### Scenario: Installed CLI differs from source

- **WHEN** the installed CLI lacks a command described by a skill
- **THEN** the skill reports the mismatch and uses only supported surfaces or stops that workflow explicitly

### Requirement: Plugin content is source-owned and generic

The plugin SHALL be packaged from source with installation instructions and SHALL use synthetic examples. It SHALL not embed facts from a particular user's workspace or alter installed cache copies as its source of truth.

#### Scenario: Plugin is installed in a new workspace

- **WHEN** an agent loads the plugin in a workspace with different package and task-runner conventions
- **THEN** the guidance derives those facts from that workspace's configuration and does not assume a prior workspace's names or commands
