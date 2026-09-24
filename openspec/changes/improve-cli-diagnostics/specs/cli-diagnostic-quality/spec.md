## ADDED Requirements

### Requirement: Wrong manifest families fail with typed errors

The system SHALL validate a supplied manifest's family and version before dereferencing command-specific fields. A wrong or unsupported family SHALL produce a stable diagnostic naming the expected and observed forms and SHALL NOT throw an unhandled runtime exception.

#### Scenario: Extraction reviewer receives a preparation manifest

- **WHEN** an extraction-only review command receives a preparation manifest
- **THEN** it returns a wrong-family diagnostic with the appropriate preparation review command or an explicit unsupported status

### Requirement: Invocation errors identify the next valid action

The system SHALL distinguish candidate IDs, package names, output paths, and unsupported flags in usage errors. Its diagnostic SHALL name the failed input contract and one valid lookup or correction step without changing the user's requested scope.

#### Scenario: Output path escapes the workspace

- **WHEN** a report destination lies outside the permitted workspace
- **THEN** the command refuses it and explains the workspace-relative requirement with a safe example

#### Scenario: Package name supplied as candidate ID

- **WHEN** a package label is passed where a candidate ID is required
- **THEN** the command identifies the argument mismatch and points to candidate discovery

### Requirement: Discovery output states its completeness

Human discovery output SHALL display totals, qualification, shown-entry limits, omissions, and the command to obtain complete detail. Machine output SHALL use a stable schema and SHALL mark any limit explicitly.

#### Scenario: Large candidate portfolio

- **WHEN** a portfolio exceeds the default human display limit
- **THEN** the summary reports the total and omitted count rather than implying that displayed entries are complete
