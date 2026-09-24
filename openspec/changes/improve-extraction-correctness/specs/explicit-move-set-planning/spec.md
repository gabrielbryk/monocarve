## ADDED Requirements

### Requirement: A reviewed move set can be planned directly

The system SHALL accept an explicit source set and destination package when no portfolio candidate matches the intended boundary. It SHALL apply the same protected-path, source-closure, composition-root, configuration, and manifest-validation rules as candidate planning. Any required closure expansion SHALL be displayed and explicitly accepted before a manifest is written.

#### Scenario: Requested files do not fit a candidate

- **WHEN** the operator selects files that form a valid closure but are absent from one portfolio candidate
- **THEN** the system can compile their reviewed move set without silently substituting a different candidate

#### Scenario: Source selection omits a required closure member

- **WHEN** a selected move would leave an invalid dependency edge or omit a required source
- **THEN** the planner identifies the missing file and refuses to compile until the expanded scope is reviewed

### Requirement: Force does not broaden source selection

The system SHALL NOT interpret an eligibility override as permission to include unselected files or bypass closure and protected-path rules.

#### Scenario: Operator forces an ineligible candidate

- **WHEN** `--force` is used with a candidate
- **THEN** the candidate's source set remains unchanged and all structural safety checks still run
