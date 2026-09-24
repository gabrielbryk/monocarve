## ADDED Requirements

### Requirement: Advisory guidance is available without a transaction

The system SHALL produce extraction guidance for selected source files or a candidate from the current checkout without creating a worktree, approval commit, or source mutation. Guidance SHALL identify exact move destinations, known consumers, package and export wiring, generated artifacts, risks, and relevant configured checks. Files outside analyzed graph coverage SHALL be identified explicitly.

#### Scenario: Developer chooses an explicit source set

- **WHEN** a developer requests guidance for files in an existing checkout
- **THEN** the system reports the proposed move and its known affected surface without requiring an extraction manifest or clean worktree

#### Scenario: A requested file is outside analysis coverage

- **WHEN** a selected file is not represented in the configured graph
- **THEN** the report marks consumer and boundary conclusions unavailable for that file and does not call the move safe

### Requirement: Review the user's actual working-tree change

The system SHALL review staged, unstaged, and untracked changes against an explicit base revision without modifying Git or source files. It SHALL report known missing consumer rewrites, unresolved imports, package wiring and boundary problems, and relevant paths it could not assess. The system SHALL refuse to publish a coherent review if relevant inputs change during analysis.

#### Scenario: A consumer was not updated

- **WHEN** a source file is moved and a known consumer still refers to its old location
- **THEN** the review fails the consumer check and names that consumer

#### Scenario: A source file changes during review

- **WHEN** a relevant file or Git index changes after review begins
- **THEN** the review returns a stale-input diagnostic instead of combining observations from different states

### Requirement: Evidence labels distinguish inspection from execution

Each advisory check SHALL state `passed`, `failed`, `not-run`, or `unavailable` and its evidence. Suggested repository commands SHALL be labeled as suggestions until executed. The report SHALL NOT claim transactional replay, rollback, or repository-gate success.

#### Scenario: Gates were suggested but not run

- **WHEN** the advisory report lists configured package and project gates
- **THEN** those gates appear as `not-run` and no success verdict depends on them
