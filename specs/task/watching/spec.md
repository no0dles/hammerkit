# Feature Specification: Task: Watching

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/watching.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Restart a task automatically on source file changes (Priority: P1)

A developer runs an API server task and wants it to restart whenever the source code changes. They run `hammerkit <task> --watch`. Hammerkit watches the task's declared `src` files and folders; when a change is detected it restarts the task.

**Why this priority**: Watch mode is the primary developer-experience feature for iterative development workflows.

**Independent Test**: Start a task with `--watch` and a `src` folder; modify a file in the folder and observe that the task process is terminated and restarted.

**Acceptance Scenarios**:

1. **Given** a task with `src` defined and the `--watch` flag, **When** a file in `src` changes, **Then** hammerkit terminates the running task and restarts it.
2. **Given** a task with `src` defined and the `--watch` flag, **When** no files change, **Then** the task continues running without interruption.

### User Story 2 - Mark a self-managing task as continuous (Priority: P2)

A developer uses Angular CLI's `ng serve` which handles its own file watching and incremental rebuilding internally. They mark the task with `continuous: true`. When watch mode is active, hammerkit does not watch the `src` directory for that task, allowing the tool to manage its own restart cycle.

**Why this priority**: Self-managing tasks (Angular, webpack --watch, etc.) would otherwise be redundantly restarted by hammerkit on top of their own internal watching, causing conflicts.

**Independent Test**: Mark a task `continuous: true` and run with `--watch`; modify a source file and verify hammerkit does NOT restart the task process (the task handles its own reload).

**Acceptance Scenarios**:

1. **Given** a task with `continuous: true` and the `--watch` flag, **When** a file in `src` changes, **Then** hammerkit does NOT restart the task process.
2. **Given** a task with `continuous: true` but WITHOUT `--watch`, **When** the task is run normally, **Then** the `continuous` flag has no visible effect on single-run behavior.
3. **Given** a mix of continuous and non-continuous tasks in watch mode, **When** a source file for the non-continuous task changes, **Then** only the non-continuous task is restarted.

### Edge Cases

- A task without `src` declared has nothing to watch; behavior with `--watch` and no `src` is not specified (assumed to run once and stay alive without restart triggers).
- `continuous: true` only suppresses hammerkit-level file watching; it does not affect how the task's process itself behaves.
- Watch mode with a container task follows the same restart semantics as a local task.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support a `--watch` CLI flag on the execute command.
- **FR-002**: When `--watch` is active, the system MUST monitor the `src` files and folders of a task for changes.
- **FR-003**: When a change is detected in watched sources, the system MUST terminate the running task process and restart it.
- **FR-004**: The system MUST accept a `continuous: true` field on a task.
- **FR-005**: When a task has `continuous: true` and watch mode is active, the system MUST NOT watch the task's `src` for changes or restart it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Modifying a source file of a watched non-continuous task causes the task to restart within a reasonable detection window.
- **SC-002**: Modifying a source file of a watched continuous task does NOT cause hammerkit to restart that task process.
- **SC-003**: A task without `continuous: true` runs and restarts under `--watch` as expected.

## Assumptions

- Watch mode monitors the same `src` paths used for caching; the two features share source declarations.
- The file-system polling or event mechanism used for watching is an implementation detail not described in the docs.
- `continuous: true` is intended for tasks that have their own internal watch loop (e.g., webpack, ng serve, jest --watch).
- Watch mode operates for the lifetime of the hammerkit process; Ctrl-C stops watching and terminates all running tasks.
