# Feature Specification: Build File: Environment Variables

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/build-file/environment-variables.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pass shell environment variables into a task (Priority: P1)

A developer needs a task to use a variable (e.g. `VERSION`) that is set in the shell before running hammerkit. They declare the variable in the task's `envs:` block referencing the shell value (`$VERSION`). Hammerkit validates the variable is set and injects it into the task execution environment.

**Why this priority**: This is the most common env-var pattern; it prevents silent failures from unset variables.

**Independent Test**: Export a variable in the shell, declare it in the task `envs:`, run the task, and confirm the command receives the correct value. Then unset the variable and confirm hammerkit throws an error rather than passing an empty value.

**Acceptance Scenarios**:

1. **Given** a shell variable `VERSION=1.0.0` is exported, **When** a task declares `VERSION: $VERSION` in its `envs:` and runs `echo $VERSION`, **Then** the output is `1.0.0`.
2. **Given** a task declares `VERSION: $VERSION` but the shell variable is not set, **When** the task is invoked, **Then** hammerkit throws an error before executing any commands.

### User Story 2 - Use .env file for secret values (Priority: P2)

A developer stores sensitive credentials (e.g. `NPM_TOKEN`) in a `.env` file that is excluded from version control. The task `envs:` block references the variable using the `$NPM_TOKEN` syntax. Hammerkit reads the `.env` file and makes the value available to the task.

**Why this priority**: Keeps secrets out of the build file and version history while still being available during task execution.

**Independent Test**: Create a `.env` file with `NPM_TOKEN=abc`, declare it in the task `envs:`, run the task, and confirm the token is available to the command.

**Acceptance Scenarios**:

1. **Given** a `.env` file containing `NPM_TOKEN=abc`, **When** a task declares `NPM_TOKEN: $NPM_TOKEN` in its `envs:` and is executed, **Then** the command receives `NPM_TOKEN=abc`.

### User Story 3 - Define environment variables in the build file (Priority: P2)

A developer defines default values for environment variables at the top-level `envs:` block or within a specific task's `envs:` block. Task-level declarations override the file-level defaults for that task only.

**Why this priority**: Centralises configuration that does not change per-developer while allowing per-task overrides.

**Independent Test**: Declare `NODE_VERSION: 14.16.0` at the top level and `NODE_VERSION: 14.0.0` inside one task's `envs:`. Run each task and verify each receives the correct version string.

**Acceptance Scenarios**:

1. **Given** `NODE_VERSION: 14.16.0` is declared in the top-level `envs:`, **When** a task that does not override it runs `echo $NODE_VERSION`, **Then** the output is `14.16.0`.
2. **Given** a task declares `NODE_VERSION: 14.0.0` in its own `envs:`, **When** that task runs, **Then** its value (`14.0.0`) takes precedence over the top-level value.
3. **Given** top-level `envs:` are declared in file A, **When** a task from a referenced or included build file B runs, **Then** it does NOT have access to file A's top-level env vars.

### Edge Cases

- Referencing an undefined shell variable that is not in `.env` causes a hard error before task execution begins.
- Variables declared in a build file's top-level `envs:` are scoped to that file; they do not leak into referenced or included build files.
- The `.env` file is loaded relative to the project directory containing the build file.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support declaring environment variables in the top-level `envs:` map of a build file, making them available to all tasks in that file.
- **FR-002**: The system MUST support declaring environment variables in a task-level `envs:` map, overriding any same-named top-level declaration for that task.
- **FR-003**: The system MUST resolve `$VAR` references in `envs:` values from the shell environment at the time the task is executed.
- **FR-004**: The system MUST read environment variable values from a `.env` file in the project directory and make them available for `$VAR` resolution.
- **FR-005**: The system MUST throw an error if an `envs:` entry references a shell or `.env` variable that is not defined, rather than passing an empty or undefined value to the task.
- **FR-006**: Top-level `envs:` declarations MUST be scoped to the build file in which they are defined and MUST NOT be visible to referenced or included build files.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task that declares a shell-sourced env var receives the correct value when the variable is set, and hammerkit exits with a non-zero code and an error message when the variable is unset.
- **SC-002**: A task that sources a value from `.env` receives the correct value without the secret appearing in the build file.
- **SC-003**: A task-level `envs:` declaration overrides a file-level declaration for the same variable name within that task only.
- **SC-004**: Tasks in a referenced or included build file do not inherit top-level env vars from the including build file.

## Assumptions

- `.env` file loading is automatic; no explicit declaration in the build file is needed beyond the `$VAR` reference in `envs:`.
- Variables defined as literal values in `envs:` (not using `$VAR` syntax) are always available and require no shell validation.
- The precedence order (most specific wins) is: task-level `envs:` > top-level `envs:` > `.env` file > shell environment, though the docs do not enumerate this explicitly; this assumption is recorded here for review.
