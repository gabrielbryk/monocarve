## ADDED Requirements

### Requirement: Preflight identifies detectable transaction prerequisites

The system SHALL report the status of Git worktree creation policy, configured scratch location, dependency strategy, lockfile prerequisites, and configured gates before manifest approval. Each prerequisite SHALL be `ready`, `blocked`, or `unknown`, with the evidence and limits of that classification. A default readiness inspection SHALL NOT mutate the repository. An explicit probe SHALL own and clean only its disposable artifacts.

#### Scenario: Host Git policy blocks worktree creation

- **WHEN** an explicit worktree probe is blocked by the host's Git wrapper
- **THEN** readiness reports the worktree prerequisite as blocked, includes the failing command and cause, and does not claim that simulation or gates ran

#### Scenario: Dependency setup is not proven

- **WHEN** the selected dependency strategy cannot be verified cheaply
- **THEN** readiness reports it as unknown and lists the commands or links that simulation will require

### Requirement: Transaction results expose actual costs and failure origin

The system SHALL report elapsed duration for completed simulation and apply phases and each executed gate. It SHALL classify a failure by phase and stable cause code, with exact command, relevant paths, and bounded log location where available. These measurements SHALL NOT affect deterministic manifests or plan IDs.

#### Scenario: A repository gate times out

- **WHEN** a configured gate exceeds its timeout
- **THEN** the result names its tier, command, timeout, elapsed duration, and log location, and identifies the gate phase as the failure source

#### Scenario: Simulation cannot establish compiler dependencies

- **WHEN** simulation fails because required types are absent from its isolated dependency state
- **THEN** the result identifies that setup evidence and does not present it as a proven defect in the proposed move

### Requirement: Baseline drift is explained without silent approval

The system SHALL identify changed plan-sensitive inputs and distinguish provenance-only drift from changes to moves, consumers, wiring, gates, and outputs. Refresh SHALL write a new reviewable manifest and SHALL NOT make the old approval valid for the new baseline.

#### Scenario: Configuration changes after planning

- **WHEN** a relevant configuration file changes before apply
- **THEN** the system names the changed input and required review action; apply continues to refuse the stale approved manifest
