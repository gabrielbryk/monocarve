## ADDED Requirements

### Requirement: A plan establishes exact target and import resolution

Before approval, the system SHALL show every moved file's target path and verify that resulting relative imports, package self-imports, and known production and test consumers resolve to their intended files or exported specifiers. An unresolved or redirected import SHALL block the plan with the affected path and edge.

#### Scenario: Flattening a target breaks a sibling import

- **WHEN** a moved file's relative import no longer resolves at its proposed target path
- **THEN** the planner refuses the plan and reports the source, target, and broken specifier

#### Scenario: A test consumer is omitted

- **WHEN** a test outside the move set imports a moved module
- **THEN** the plan includes its rewrite or reports why it cannot safely do so and refuses completeness

### Requirement: Package wiring is complete for the configured workspace

The system SHALL verify package identity, exports, workspace references, dependency sections, and lockfile importer operations required by the configured adapters. It SHALL report missing configured scaffold support explicitly and SHALL NOT fabricate workspace conventions.

#### Scenario: A new package reference lacks importer wiring

- **WHEN** a planned consumer gains a workspace dependency that requires a lockfile importer update
- **THEN** the plan contains that operation or refuses approval with the missing importer identified

#### Scenario: Adapter support is absent

- **WHEN** an adapter cannot compute required package wiring
- **THEN** the planner returns its explicit unsupported error and does not return plausible partial operations
