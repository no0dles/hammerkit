# Feature Specification: CLI: validate

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/validate.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Catch build-file errors before running tasks (Priority: P1)

A developer edits `.hammerkit.yaml` and wants to verify the configuration is correct before triggering a potentially long-running build. They run `hammerkit validate`, which checks the build file for invalid configurations or missing information and reports any problems immediately.

**Why this priority**: Early error detection prevents wasted time on builds that would fail partway through due to a misconfigured build file.

**Independent Test**: Introduce a deliberate misconfiguration in a build file (e.g., a task referencing a non-existent dependency). Run `hammerkit validate`. Confirm the command exits with a non-zero code and reports the error. Then fix the file and confirm `hammerkit validate` exits successfully.

**Acceptance Scenarios**:

1. **Given** a build file with a valid configuration, **When** `hammerkit validate` is run, **Then** the command exits with a success code and reports no errors.

2. **Given** a build file with an invalid configuration (e.g., missing required fields, unknown references), **When** `hammerkit validate` is run, **Then** the command exits with a non-zero code and reports a clear description of each problem found.

3. **Given** a build file with missing required information, **When** `hammerkit validate` is run, **Then** the specific missing information is identified in the output.

### User Story 2 - Use validate as a CI linting step (Priority: P2)

A CI pipeline operator adds `hammerkit validate` as an early linting job alongside other linters so that build-file errors are caught on every pull request before any build or test jobs run.

**Why this priority**: The docs explicitly recommend this usage pattern; catching errors in CI prevents broken build configurations from reaching the main branch.

**Independent Test**: Add `hammerkit validate` to a CI job. Introduce a build-file error on a branch. Confirm the CI job fails. Fix the error and confirm the CI job passes.

**Acceptance Scenarios**:

1. **Given** `hammerkit validate` is included as a CI job step, **When** a pull request introduces an invalid build file, **Then** the CI job fails and the error is visible in the CI output before any build or test jobs run.

2. **Given** a valid build file, **When** `hammerkit validate` runs in CI, **Then** the job passes and downstream jobs are not blocked.

### Edge Cases

- Running `hammerkit validate` when no build file exists should exit with a non-zero code and report a clear error about the missing file.
- A build file that is syntactically valid YAML but contains semantically invalid hammerkit configuration (e.g., referencing an undefined task as a dependency) should be caught by validate.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST parse and validate the build file when `hammerkit validate` is run.
- **FR-002**: System MUST exit with a success code when the build file contains no invalid configurations or missing required information.
- **FR-003**: System MUST exit with a non-zero code and report all detected errors when the build file contains invalid configurations or missing required information.
- **FR-004**: Error output MUST describe each problem clearly enough for a developer to identify and fix it without additional tooling.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `hammerkit validate` exits with code 0 for every valid build file accepted by `hammerkit run`.
- **SC-002**: `hammerkit validate` exits with a non-zero code for every build file that would cause `hammerkit run` to fail due to a configuration error.
- **SC-003**: Each error message produced by `hammerkit validate` identifies the location or nature of the problem sufficiently for a developer to correct it.

## Assumptions

- `hammerkit validate` validates the build file in the current working directory (defaulting to `.hammerkit.yaml`); alternate file paths are not documented and are assumed unsupported by this command.
- The command performs static analysis only — it does not execute tasks, pull images, or make network calls to verify external resources.
- No `--filter`/`--exclude` options are documented for `validate`; the command always validates the entire build file.
- "Invalid configurations" includes but may not be limited to: undefined task/service references, missing required fields, and type mismatches in the schema.
