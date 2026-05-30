# Feature Specification: Task: Dependencies

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/dependencies.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chain tasks with dependencies (Priority: P1)

A developer has three tasks — `install`, `build`, and `publish` — where each step must complete before the next starts. They declare `deps` on each downstream task. When running `hammerkit publish`, hammerkit resolves the full chain and executes each task in dependency order.

**Why this priority**: Dependency ordering is the foundational orchestration primitive; without it users must run tasks manually in sequence.

**Independent Test**: Define a three-task chain and run the last one; observe that all three execute in correct order.

**Acceptance Scenarios**:

1. **Given** tasks A, B, C where B depends on A and C depends on B, **When** the user runs `hammerkit C`, **Then** A executes first, then B, then C.
2. **Given** a dependency chain where task A fails, **When** the user runs `hammerkit C`, **Then** B and C are not executed and the run aborts with a failure.
3. **Given** a dependency is already cached (sources unchanged), **When** the user runs a downstream task, **Then** the cached dependency is skipped and the downstream task still runs.

### User Story 2 - Deep dependency chains (Priority: P2)

A developer in a monorepo builds deeply nested dependency graphs. Hammerkit resolves chains of arbitrary depth as long as there are no cycles.

**Why this priority**: Monorepos commonly have multi-level dependency trees.

**Independent Test**: Create a 5-level dependency chain and confirm all levels execute in the correct order.

**Acceptance Scenarios**:

1. **Given** a dependency graph N levels deep with no cycles, **When** the leaf task is invoked, **Then** all ancestors execute in topological order.
2. **Given** a build file where task A depends on task B and task B depends on task A, **When** any task in the cycle is invoked, **Then** hammerkit reports an error and does not execute any task.

### Edge Cases

- A task with an empty `deps: []` list is treated the same as a task with no `deps` field.
- If any dependency in the chain fails, all pending downstream tasks are aborted.
- Circular dependency graphs (loops) are explicitly prohibited and must be detected at parse/plan time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a `deps` list of task names on any task.
- **FR-002**: The system MUST execute all tasks listed in `deps` before executing the dependent task.
- **FR-003**: The system MUST abort execution of all pending tasks when any dependency task fails.
- **FR-004**: The system MUST support arbitrarily deep dependency chains.
- **FR-005**: The system MUST detect and reject cyclic dependency graphs (loops).
- **FR-006**: A dependency task that is cached (all sources unchanged) MUST be skipped without re-executing, and downstream tasks that still need to run MUST continue normally.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Running a task with a two-level dependency chain results in the dependency executing first, followed by the requested task.
- **SC-002**: When a dependency fails, no tasks that depend on it (directly or transitively) are executed.
- **SC-003**: Cyclic dependencies cause hammerkit to exit with an error before executing any command.
- **SC-004**: A cached dependency does not re-execute; its downstream task still executes if needed.

## Assumptions

- `deps` values must reference tasks defined within the same build file or an included build file; cross-build-file references follow the include/namespace conventions described elsewhere.
- Dependency resolution is eager: all dependencies of a task are resolved before that task starts, not lazily during execution.
- Parallel execution of independent siblings within a dependency graph is outside the scope of this page and is not specified here.
