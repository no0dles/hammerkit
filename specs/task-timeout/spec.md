# Feature Specification: Task Timeout

**Feature Branch**: `014-task-timeout`

**Created**: 2026-05-31

**Status**: Draft

**Input**: Real-world feedback — a stuck test can hang forever; the current mitigation is the test framework's own `--test-timeout`. A hammerkit-native, runtime-agnostic task timeout would make any stuck task fail cleanly instead of hanging, regardless of what runs inside it.

## Motivation

There is no `timeout` anywhere in the schema today. A task that hangs (a deadlocked process, a wedged network call, a sandbox that never returns) blocks the whole run indefinitely. Relying on each tool's own timeout flag is inconsistent and only works for tools that have one. A task-level timeout, enforced through hammerkit's existing abort path (`checkForAbort(options.abort)`), turns an indefinite hang into a deterministic failure.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fail a stuck task instead of hanging (Priority: P1)

A developer sets a `timeout` on a task. If it runs longer than that, hammerkit aborts it and the task fails with a timeout reason.

**Why this priority**: This is the core value — bounding a hang so CI fails fast instead of stalling until the job's outer limit.

**Independent Test**: A task that sleeps longer than its `timeout` fails within the timeout window, and its container/process is cleaned up.

**Acceptance Scenarios**:

1. **Given** a task with a `timeout`, **When** it exceeds that duration, **Then** it is aborted and reported as failed with a timeout reason.
2. **Given** a task that completes within its `timeout`, **When** it runs, **Then** the timeout has no effect.

### User Story 2 - Global default timeout (Priority: P2)

A developer sets a global `--timeout` so every task without its own gets a default ceiling.

**Why this priority**: A single safety net for an entire build is convenient for CI; per-task overrides handle the exceptions.

**Independent Test**: With a global timeout and no per-task value, a hanging task fails at the global ceiling.

**Acceptance Scenarios**:

1. **Given** a global `--timeout` and a task with no own timeout, **When** the task exceeds the global value, **Then** it fails.
2. **Given** a task with its own `timeout`, **When** a global timeout is also set, **Then** the per-task value takes precedence.

### Edge Cases

- A timed-out task MUST NOT write a cache entry (a hang is not a successful build).
- On timeout, the container/process MUST be cleaned up — no orphaned container or volume.
- Timeout across runtimes (local, Docker, Kubernetes) MUST use the same abort mechanism and behave consistently.
- A timeout firing during the task's own cleanup MUST still leave the system in a clean state.
- No timeout configured → current behavior (run until completion) is preserved.
- A service that never becomes healthy is a related but distinct concern (readiness timeout) — **kept separate and deferred**; this spec covers task execution time only.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A task MUST accept an optional `timeout` (a duration); on expiry the task MUST be aborted via the existing abort path and reported as failed with a timeout reason.
- **FR-002**: The system MUST support a global timeout option applied as a default to tasks that declare none; a per-task `timeout` MUST take precedence over the global value.
- **FR-003**: Timeout enforcement MUST work consistently across the local, Docker, and Kubernetes runtimes.
- **FR-004**: A timed-out task MUST NOT write a cache entry.
- **FR-005**: On timeout, the system MUST clean up the task's container/process (no orphans).
- **FR-006**: With no timeout configured, behavior MUST be identical to today (additive, non-breaking — Stable Contracts).
- **FR-007**: Duration values MUST use a documented format (e.g. `30s`, `5m`); invalid values MUST be rejected at validation time.

### Key Entities

- **Timeout**: a duration, settable per task and/or globally, bounding a task's execution time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task that exceeds its timeout fails within the timeout window rather than hanging.
- **SC-002**: After a timeout, no orphaned container/volume remains and no cache entry is written.
- **SC-003**: A per-task timeout overrides the global timeout.
- **SC-004**: A build file with no timeout configured behaves identically to the prior version.

## Assumptions

- Enforcement reuses the existing abort signal already threaded through execution (`checkForAbort(options.abort)`), so the timeout is a timer that triggers that abort rather than a new cancellation mechanism.
- This complements [container-runtime-options](../container-runtime-options/spec.md): together they replace the NOTE-block + manual `--test-timeout` workaround on the affected sandbox test task.
- Scope is task execution time; service readiness timeouts are deferred unless a concrete need merges them in.
