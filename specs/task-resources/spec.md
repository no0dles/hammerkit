# Feature Specification: Task CPU & Memory Resources

**Feature Branch**: `007-task-resources`

**Created**: 2026-05-31

**Status**: Draft

**Input**: 1.7 brainstorm — declare cpu/memory requests and limits per task (and service), enforced on Docker and Kubernetes, and used as a budget for resource-aware local scheduling. Today the scheduler uses a flat `--concurrency` worker count (default 4) with no awareness of how heavy each task is.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Limit a containerized task's resources (Priority: P1)

A developer declares `resources` (cpus, memory) on a task with an `image`. On Docker the container is created with those CPU/memory limits; on Kubernetes the job container gets matching `requests`/`limits`.

**Why this priority**: Bounding a heavy build step is a common, concrete need and maps cleanly onto both container runtimes hammerkit already targets.

**Independent Test**: Declare `resources: { cpus: 1, memory: 512Mi }` on a Docker task and verify the created container's host config carries the corresponding CPU and memory limits.

**Acceptance Scenarios**:

1. **Given** a Docker task with `resources`, **When** it runs, **Then** the container is created with the matching CPU (NanoCpus) and memory limits.
2. **Given** a Kubernetes environment and a task with `resources`, **When** the job is created, **Then** the container spec carries matching `resources.requests`/`resources.limits`.
3. **Given** a task with no `resources`, **When** it runs, **Then** behavior is exactly as today (no limits applied).

### User Story 2 - Constrain a service's resources (Priority: P1)

The same `resources` block applies to services, so a needed database (Docker container or k8s deployment) can declare its footprint.

**Why this priority**: Services and tasks share the runtime; asymmetry here would be surprising and violate composability.

**Independent Test**: A `postgres` service with `resources` produces a k8s deployment whose container carries the matching `resources`.

**Acceptance Scenarios**:

1. **Given** a service with `resources`, **When** it starts on Docker or Kubernetes, **Then** the container/deployment carries the matching limits/requests.

### User Story 3 - Resource-aware local scheduling (Priority: P2 — DEFERRED)

> Deferred past the initial release: resources ship **enforcement-only** first. Kept here as the intended direction, not initial scope.

When tasks declare `cpus`, the local scheduler admits work against a CPU budget (default: host CPU count) instead of a flat worker count, so parallel tasks don't oversubscribe the machine.

**Why this priority**: Turns the declaration into a local-first win — the same value that sets k8s requests also drives laptop scheduling ("two features, one config"). Secondary because Layer 1 (enforcement) already justifies the feature.

**Independent Test**: With a 4-CPU budget and three tasks each declaring `cpus: 2`, verify no more than two run concurrently.

**Acceptance Scenarios**:

1. **Given** declared per-task `cpus` and a CPU budget, **When** the scheduler runs the graph, **Then** the sum of `cpus` of concurrently-running tasks never exceeds the budget.
2. **Given** no `resources` are declared anywhere, **When** the graph runs, **Then** scheduling behaves as today (flat `--concurrency`).

### Edge Cases

- `cpus` greater than the host/cluster capacity → **warn-and-run, never clamp**. On Docker the limit applies as-is; on Kubernetes an over-capacity request leaves the pod Pending (surfaced by the existing running-state wait) — k8s's own behavior, not a hammerkit clamp.
- A local (non-container) task with `resources` → MUST NOT fail; enforcement is not guaranteed and the value is used only as a scheduling hint. `dry-run`/`explain` SHOULD note non-enforcement.
- k8s `requests` greater than `limits` → rejected with a clear validation error.
- A single value form vs split requests/limits (see Key Entities / clarification).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Tasks and services MUST accept an optional `resources` block with `cpus` and `memory`.
- **FR-002**: For Docker container tasks/services, the system MUST translate `resources` to host-config CPU (NanoCpus) and memory limits.
- **FR-003**: For Kubernetes jobs/deployments, the system MUST translate `resources` to container `resources.requests` and `resources.limits`.
- **FR-004**: Units MUST follow Kubernetes conventions — CPU as cores or millicores (e.g. `2`, `500m`), memory as `Mi`/`Gi`.
- **FR-005**: For local (non-container) tasks, `resources` MUST NOT cause a failure; enforcement is best-effort/none and the value serves only as a scheduling hint.
- **FR-006** (DEFERRED): resource-aware scheduling is out of scope for the initial release — resources are **enforcement-only** (Docker/k8s limits) and `--concurrency` is unchanged. A CPU-budget admission model may follow when a concrete need arises.
- **FR-007**: Tasks/services without `resources` MUST behave exactly as before (additive, non-breaking — Stable Contracts).
- **FR-008**: Invalid resource values (unparseable units, requests > limits) MUST be rejected at validation time with a clear message.

### Key Entities

- **Resource spec**: `resources: { cpus, memory }`. The value sets the **limit**; on Kubernetes the request is set equal to the limit. No split requests/limits form for now (deferred until a concrete need).
- **CPU budget**: the total concurrent CPU the local scheduler will admit (default host CPU count).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Docker task with `resources` produces a container whose CPU and memory limits match the declaration.
- **SC-002**: A k8s task/service with `resources` produces a container spec with matching `requests`/`limits`.
- **SC-003**: With a CPU budget and over-subscribing tasks, concurrent CPU demand never exceeds the budget.
- **SC-004**: A build file with no `resources` produces byte-identical runtime behavior to the prior version.

## Assumptions

- Docker limits are applied where the host config is built ([docker-task.ts](../../src/executer/docker-task.ts)); k8s limits follow the schema→spec translation pattern used for healthcheck probes in `ensure-kubernetes-deployment-exists.ts`.
- Kubernetes conventions are adopted as the single vocabulary because hammerkit is already k8s-aware; Docker and local translate *from* that vocabulary.
- Layer 1 (enforcement on Docker + k8s) ships first and stands alone; Layer 2 (resource-aware scheduling) is a follow-on once the schema is settled.
