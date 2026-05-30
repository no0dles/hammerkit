# Feature Specification: CLI: execute

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/execute.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Running a task by name (Priority: P1)

A developer wants to build a specific artifact. They run `hammerkit <task-name>` (or `hammerkit run <task-name>`) and hammerkit executes that task and all its declared dependencies inside the appropriate containers.

**Why this priority**: Executing tasks is the core purpose of the tool; all other features support this.

**Independent Test**: Given a build file with a task named `example`, run `hammerkit example` and verify it completes successfully and produces the expected output.

**Acceptance Scenarios**:

1. **Given** a build file with a task `build`, **When** the user runs `hammerkit build`, **Then** hammerkit executes the `build` task (and its dependencies) and exits with code 0 on success.

2. **Given** a build file with a task `build`, **When** the user runs `hammerkit run build`, **Then** the result is identical to running `hammerkit build`.

3. **Given** a task name that does not exist in the build file, **When** the user runs `hammerkit <nonexistent>`, **Then** hammerkit exits with a non-zero code and a meaningful error message.

### User Story 2 - Filtering tasks by labels (Priority: P2)

A monorepo developer wants to run only the iOS build tasks. They use `--filter` to include only tasks with a matching label or `--exclude` to skip tasks with a given label, so unrelated tasks are not executed.

**Why this priority**: Label-based filtering is a key scalability feature for large builds with many tasks.

**Independent Test**: Given a build file with tasks labeled `build=ios` and `build=android`, run `hammerkit -f build=ios` and verify only the iOS tasks (and their dependencies) execute.

**Acceptance Scenarios**:

1. **Given** tasks with label `type=build` and tasks without that label, **When** the user runs `hammerkit -f type=build`, **Then** only tasks matching `type=build` are executed; dependent tasks without that label may still run to satisfy dependencies.

2. **Given** tasks with label `build=ios`, **When** the user runs `hammerkit -e build=ios`, **Then** tasks with `build=ios` are excluded; if a dependent task also matches the excluded label, it is excluded too.

3. **Given** multiple label filters, **When** the user provides multiple `-f` arguments, **Then** only tasks matching all specified labels are included.

### User Story 3 - Controlling concurrency, caching, and log mode (Priority: P3)

A developer running on a slow machine wants to limit parallel workers, or a CI engineer wants checksum-based caching and grouped log output. They pass the relevant flags to tune hammerkit's behavior for their environment.

**Why this priority**: These are power-user options that improve CI reliability and local performance but are not needed for basic usage.

**Independent Test**: Run `hammerkit run <task> --concurrency 1` and verify tasks execute sequentially (no interleaved log lines from parallel workers).

**Acceptance Scenarios**:

1. **Given** a build file with multiple independent tasks, **When** the user runs `hammerkit -c 1`, **Then** tasks execute one at a time rather than in parallel.

2. **Given** a CI environment, **When** hammerkit detects CI, **Then** `--log` defaults to `live` and `--cache` defaults to `checksum` without requiring explicit flags.

3. **Given** a local (non-CI) environment, **When** hammerkit runs without explicit `--log` or `--cache` flags, **Then** `--log` defaults to `interactive` and `--cache` defaults to `modify-date`.

4. **Given** a task with `src` files, **When** `--cache none` is specified, **Then** the task runs unconditionally without checking whether inputs have changed.

5. **Given** a task with `src` files that have not changed, **When** `--watch` is specified, **Then** hammerkit watches those files and re-executes the task when they change.

### Edge Cases

- Specifying both `--filter` and `--exclude` with overlapping labels must resolve deterministically (exclude takes precedence for matched tasks).
- `--concurrency 0` or negative values should be rejected with a clear error.
- `--env <name>` is accepted but its behavior is defined by the environment configuration, not by the execute command itself.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST execute a task by name when the user supplies the task name as the first argument (with or without the explicit `run` subcommand).
- **FR-002**: System MUST execute all declared dependency tasks before the named task.
- **FR-003**: System MUST support label-based inclusion filtering via `-f / --filter <key=value>` where only tasks matching the label are directly executed (dependencies may still run).
- **FR-004**: System MUST support label-based exclusion filtering via `-e / --exclude <key=value>` where tasks (and their dependents) matching the label are skipped.
- **FR-005**: System MUST support a `-c / --concurrency <number>` option controlling the number of parallel worker threads (default: 4).
- **FR-006**: System MUST support a `-w / --watch` flag that re-executes tasks when their source files change.
- **FR-007**: System MUST support a `--cache <method>` option with choices `checksum`, `modify-date`, and `none`.
- **FR-008**: System MUST support a `-l / --log <mode>` option with choices `interactive`, `live`, and `grouped`.
- **FR-009**: System MUST default `--log` to `interactive` and `--cache` to `modify-date` outside CI, and to `live` and `checksum` inside CI.
- **FR-010**: System MUST support an `--env <name>` option to target a configured named environment.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `hammerkit <task>` and `hammerkit run <task>` produce identical exit codes and output for the same task.
- **SC-002**: With `-f type=build`, only tasks bearing the `type=build` label are directly invoked; the set of executed tasks is smaller than running without the filter.
- **SC-003**: With `-e build=ios`, no task bearing `build=ios` appears in the execution log.
- **SC-004**: With `-c 1`, task execution log lines are never interleaved across concurrent workers.
- **SC-005**: With `--cache none`, a task runs even when no source files have changed since the last run.

## Assumptions

- `hammerkit` with no subcommand and no task name runs all tasks (or the default task if one is defined); the docs show a task name is required for named execution.
- `--filter` and `--exclude` accept `key=value` pairs; partial-key matching (e.g., filtering by key name only) is not documented and assumed unsupported.
- The `--watch` flag watches the `src` files declared on the task; the exact file-watching mechanism is an implementation detail.
- CI is detected automatically via standard CI environment variables (e.g., `CI=true`); this is an informed guess not explicitly stated in the docs.
