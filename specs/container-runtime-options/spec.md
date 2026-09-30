# Feature Specification: Container Runtime & Security Options

**Feature Branch**: `013-container-runtime-options`

**Created**: 2026-05-31

**Status**: Draft

**Input**: Real-world feedback — isolated-vm sandbox workers deadlock in a plain container; they need Docker runtime options (`--shm-size`, a relaxed seccomp profile) that hammerkit's schema cannot express. The current workaround is a NOTE block on the task plus a manual timeout. This spec adds the ability to declare container runtime/security options on container tasks and services.

## Motivation

The container task schema today exposes only `image` and `mounts`; the Docker host config hammerkit builds sets just `Binds`, `ExtraHosts`, `Links`, and `AutoRemove` ([docker-task.ts](../../src/executer/docker-task.ts)). Workloads with legitimate runtime needs — shared-memory-hungry processes (Chromium, Postgres, isolated-vm), or code that needs syscalls the default seccomp profile blocks — cannot run, because there is no way to pass `--shm-size`, `--security-opt`, capabilities, or ulimits. This is a concrete, currently-worked-around gap.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Increase shared memory for a task (Priority: P1)

A developer sets `shmSize` on a container task so a workload that needs more than the default `/dev/shm` (e.g. isolated-vm sandbox workers) runs instead of deadlocking.

**Why this priority**: This is the exact failure that motivated the feature.

**Independent Test**: A task declaring an increased `shmSize` produces a container whose `/dev/shm` reflects that size, and the previously-deadlocking workload completes.

**Acceptance Scenarios**:

1. **Given** a container task with `shmSize` set, **When** it runs, **Then** the container is created with that shared-memory size.
2. **Given** the isolated-vm sandbox workload that deadlocks at the default shm size, **When** the task declares a sufficient `shmSize`, **Then** it completes rather than hanging.

### User Story 2 - Relax the seccomp / security profile (Priority: P1)

A developer sets a seccomp / security option on a task so a workload requiring otherwise-blocked syscalls can run, removing the NOTE-block workaround.

**Why this priority**: The second half of the motivating failure.

**Independent Test**: A task that fails under the default seccomp profile runs successfully when it declares the needed security option.

**Acceptance Scenarios**:

1. **Given** a container task with a seccomp/security option, **When** it runs, **Then** the container is created with that security option applied.

### User Story 3 - Service parity (Priority: P2)

The `shmSize` and `securityOpt` options apply to services, not just tasks, so a service that shares the runtime can express the same needs.

**Why this priority**: Tasks and services share the runtime; an asymmetry would be surprising.

**Independent Test**: A service declaring `shmSize` starts with that shared-memory size.

**Acceptance Scenarios**:

1. **Given** a service with `shmSize` or `securityOpt`, **When** it starts (Docker or Kubernetes), **Then** the container/pod reflects it.

> **Deferred / excluded (ADR-0003)**: `capAdd`/`capDrop`, `privileged`, `sysctls`, `tmpfs` are portable to both runtimes but out of initial scope (no concrete need yet). `ulimits` and `devices` are **excluded** — Kubernetes has no pod/container-spec equivalent.

### Edge Cases

- Unconfined seccomp (`securityOpt: seccomp=unconfined`) **widens the container's privileges** → opt-in only, documented as security-relevant; not a default.
- Invalid values (malformed size, unknown capability) → rejected at validation time with a clear message.
- A k8s cluster rejecting the resulting securityContext → a clear error attributing the rejection, not a confusing pod-create failure.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Container tasks and services MUST be able to declare two runtime options: `shmSize` and `securityOpt` (seccomp). These are the initial scope (ADR-0003).
- **FR-002**: The system MUST translate both options to the Docker host config (`ShmSize`, `SecurityOpt`) for container tasks/services.
- **FR-003**: The system MUST translate both options to Kubernetes — `shmSize` via an in-memory `emptyDir` mounted at `/dev/shm`, `securityOpt` via `securityContext.seccompProfile`.
- **FR-004**: Every exposed runtime option MUST translate to both Docker and Kubernetes (ADR-0003). `shmSize` and `securityOpt` both do, so there is no silent-drop path; options without a Kubernetes equivalent (`ulimits`, `devices`) are excluded rather than partially supported.
- **FR-005**: Unconfined seccomp MUST be opt-in and documented as security-relevant (it widens the container's privileges).
- **FR-006**: Invalid option values MUST be rejected at validation time with a clear message.
- **FR-007**: Tasks/services without runtime options MUST behave exactly as today (additive, non-breaking — Stable Contracts).

### Key Entities

- **Runtime options**: `shmSize` and `securityOpt` (seccomp), both optional, on container tasks and services.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task declaring `shmSize` produces a container with that shared-memory size, and the isolated-vm workload that deadlocked at the default completes.
- **SC-002**: A task that fails under the default seccomp profile succeeds when it declares the needed security option.
- **SC-003**: `shmSize` and `securityOpt` each produce the expected container config on **both** Docker and Kubernetes (shm via `emptyDir{medium:Memory}` at `/dev/shm`; seccomp via `securityContext.seccompProfile`).
- **SC-004**: A build file with no runtime options behaves identically to the prior version.

## Assumptions

- This spec is the security/runtime-capability axis; CPU/memory budgeting lives in [task-resources](../task-resources/spec.md). Resolved (Q7): **no shared wrapper block** — `resources` is its own sub-object, `shmSize`/`securityOpt` are flat sibling fields, consistent with the existing flat `mounts`/`volumes`.
- Adding these options removes the NOTE-block + manual-timeout workaround currently on the affected test task (see also [task-timeout](../task-timeout/spec.md)).
- Kubernetes conventions map cleanly for capabilities/seccomp/privileged via `securityContext`; shared memory maps via an in-memory `emptyDir` mounted at `/dev/shm`.
- Real Docker (and the kind cluster in CI) exercises these per "real integrations over mocks".
