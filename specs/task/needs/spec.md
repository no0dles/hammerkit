# Feature Specification: Task: Needs

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/needs.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a service before a task (Priority: P1)

A developer has a task that requires a database to be running. They declare the database service in the `services` block with a healthcheck command and reference it in the task's `needs` list. When the task is executed, hammerkit starts the service automatically and waits until the healthcheck passes before running any task commands.

**Why this priority**: Tasks that depend on services would fail silently or non-deterministically without this coordination mechanism.

**Independent Test**: Define a service with a healthcheck and a task with `needs: [<service>]`; run the task and verify the service is reachable before the first command executes.

**Acceptance Scenarios**:

1. **Given** a service with a healthcheck and a task that lists that service in `needs`, **When** the user runs the task, **Then** hammerkit starts the service and waits for the healthcheck to pass before executing the task's commands.
2. **Given** a task with `needs: [postgres]` and a postgres service whose healthcheck fails continuously, **When** the task is run, **Then** the task does not start and hammerkit reports that the service is not ready.
3. **Given** multiple tasks that each list the same service in `needs`, **When** those tasks run together, **Then** the service is started once and shared rather than started per-task.

### Edge Cases

- A service referenced in `needs` but not defined in the `services` block should cause an error at parse/plan time.
- If no healthcheck is defined on a service, hammerkit starts the task immediately after launching the service container without readiness gating.
- A task with an empty `needs: []` list is treated the same as a task with no `needs` field.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a `needs` list of service names on any task.
- **FR-002**: The system MUST start every service listed in a task's `needs` before executing that task's commands.
- **FR-003**: When a service declares a `healthcheck`, the system MUST wait for the healthcheck to succeed before the dependent task starts.
- **FR-004**: The system MUST NOT start a task whose `needs` services have not yet passed their healthchecks.

### Key Entities

- **Service**: A long-running container process declared in the top-level `services` block. Key attributes: `image`, `healthcheck` (optional, with `cmd`).
- **Needs**: A list of service names on a task that declares runtime dependencies on those services.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task with `needs: [postgres]` does not execute its first command until the postgres service's healthcheck returns success.
- **SC-002**: When a service healthcheck never passes, the dependent task never starts and hammerkit reports a failure.
- **SC-003**: A service listed in `needs` by multiple tasks is started exactly once per run.

## Assumptions

- `needs` expresses a runtime service dependency, distinct from `deps` which expresses a task execution dependency.
- Healthcheck polling interval and timeout are implementation details not specified in the docs; they are assumed to be reasonable defaults.
- Services are stopped by hammerkit after all tasks that need them have completed, though the exact lifecycle is not described on this page.
