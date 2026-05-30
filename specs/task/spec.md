# Feature Specification: Task: Overview

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/README.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a minimal task (Priority: P1)

A developer defines a task with only a list of commands in `.hammerkit.yaml` and runs it. Hammerkit executes each command in sequence. No source or output declarations are required for the most basic use case.

**Why this priority**: This is the entry-point experience; every other feature builds on it.

**Independent Test**: Create a `.hammerkit.yaml` with a single `echo` command task and run it — the output should appear in the terminal.

**Acceptance Scenarios**:

1. **Given** a `.hammerkit.yaml` with a task containing only `cmds`, **When** the user runs `hammerkit <task>`, **Then** each command executes in order and the process exits with the command's exit code.

### User Story 2 - Declare source files to enable caching (Priority: P1)

A developer adds a `src` list to a task. On subsequent runs where none of the listed files have changed, hammerkit skips execution entirely and reports the task as cached.

**Why this priority**: Source-based caching is the primary performance mechanism for incremental builds.

**Independent Test**: Run the task twice with no file changes; the second run must be skipped/cached.

**Acceptance Scenarios**:

1. **Given** a task with `src` files defined, **When** those files are unchanged since the last successful run, **Then** the task is skipped.
2. **Given** a task with `src` files defined, **When** one source file changes, **Then** the task re-executes.

### User Story 3 - Declare generated output files (Priority: P2)

A developer adds a `generates` list so hammerkit knows which output directories a task produces. Generated files can optionally be exported back to the workspace or reset before each run.

**Why this priority**: Tracking outputs enables archiving/restore and correct incremental behaviour.

**Independent Test**: Run a container task with `export: true` on a generate path and verify the directory appears in the host workspace after the run.

**Acceptance Scenarios**:

1. **Given** a container task with `generates` and `export: true`, **When** the task completes, **Then** the generated directory is copied into the host workspace.
2. **Given** a task with `generates` and `resetOnChange: true`, **When** the task re-runs after a source change, **Then** the output directory is wiped before execution begins.
3. **Given** a container task with `generates` but no `export` flag, **When** the task completes, **Then** the output stays inside the container volume and is not copied to the host.

### Edge Cases

- A task with no `src` declaration is always executed (never skipped by caching).
- `resetOnChange: true` only wipes the directory when the task actually re-runs (i.e. cache miss); it has no effect when the task is skipped.
- `export: true` is only meaningful for container tasks; for local tasks outputs are already on the host filesystem.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST execute the commands of a task in the order they are declared under `cmds`.
- **FR-002**: The system MUST accept a `src` list of files, directories, or glob patterns on a task and use it to determine whether the task can be skipped.
- **FR-003**: The system MUST accept a `generates` list on a task that identifies output files or directories produced by the task.
- **FR-004**: When a generate entry carries `export: true`, the system MUST copy that path from the container volume into the host workspace after the task succeeds.
- **FR-005**: When a generate entry carries `resetOnChange: true`, the system MUST wipe that output directory before re-executing the task.
- **FR-006**: The system MUST support an optional `description` field on a task for human-readable documentation.

### Key Entities

- **Task**: The primary unit of work. Key attributes: `cmds` (required), `src` (optional), `generates` (optional), `description` (optional).
- **Generate entry**: An output path, optionally decorated with `export` (boolean) and `resetOnChange` (boolean).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task with no `src` always runs when invoked.
- **SC-002**: A task with unchanged `src` files is skipped on the second run without executing any command.
- **SC-003**: After a container task with `export: true` completes, the generated path exists on the host filesystem.
- **SC-004**: After a container task with `resetOnChange: true` re-runs, no files from a previous run remain in the output directory before the new commands execute.

## Assumptions

- The minimal task form (only `cmds`) is always a local (non-container) task unless an `image` is specified.
- "Generates" store output inside a container volume by default; the `export` flag is only relevant for container tasks.
- The `description` field is display-only and does not affect execution.
