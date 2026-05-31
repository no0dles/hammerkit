# Feature Specification: Service: Overview

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/service/README.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Running a dependency service alongside a container task (Priority: P1)

A developer needs a database available before their application task starts. They declare a `postgres` service in the build file and add it to the task's `needs` list. When they run the task, hammerkit starts the service first (waiting for its healthcheck to pass if one is configured), then starts the task container — both share a container network so the task can reach the service by its name (e.g. `postgres:5432`).

**Why this priority**: Services are the primary mechanism for wiring runtime dependencies to tasks; this is the core use case documented first.

**Independent Test**: Create a build file with a postgres service and a container task that `needs` it. Run the task and confirm it connects to postgres using the service name as the hostname.

**Acceptance Scenarios**:

1. **Given** a build file declares a `postgres` container service and a container task with `needs: [postgres]`, **When** the task is executed, **Then** hammerkit starts the postgres container before the task and the task can reach it at hostname `postgres`.

2. **Given** the postgres service has a `healthcheck` configured, **When** the task is about to start, **Then** hammerkit waits until the healthcheck exits with code 0 before launching the task container.

### User Story 2 - Using a service from a local (non-container) task (Priority: P2)

A developer runs a local task (no `image`) that needs a running service. Because the local task is not part of the container network, hammerkit injects connection details as environment variables so the process can still reach the service.

**Why this priority**: Local tasks are common for development workflows and the env-variable injection is the only way they can reach services.

**Independent Test**: Declare a container service and a local task that `needs` it. Run the local task and verify it receives `HAMMERKIT_<NAME>_HOST`, `HAMMERKIT_<NAME>_PORT`, and `HAMMERKIT_<NAME>_PORT_<containerPort>` environment variables.

**Acceptance Scenarios**:

1. **Given** a local task (no `image`) declares `needs: [postgres]` where postgres exposes port `5432`, **When** the task is executed, **Then** the process environment contains `HAMMERKIT_POSTGRES_HOST`, `HAMMERKIT_POSTGRES_PORT`, and `HAMMERKIT_POSTGRES_PORT_5432`.

2. **Given** a service exposes multiple ports, **When** a local task needing it runs, **Then** a `HAMMERKIT_<NAME>_PORT_<containerPort>` variable is injected for each exposed container port.

### User Story 3 - Manually controlling service lifetime with `up` / `down` (Priority: P2)

A developer wants to keep a shared database running across several task runs without restarting it each time. They start the service with `hammerkit up` and stop it later with `hammerkit down`.

**Why this priority**: Manual lifecycle control is important for developer-experience workflows where repeated task runs reuse a warm service.

**Independent Test**: Run `hammerkit up`, verify the service container is running, then execute a task that needs it (it should skip starting the service), then run `hammerkit down` and verify the container stops.

**Acceptance Scenarios**:

1. **Given** a service is defined, **When** `hammerkit up` is executed, **Then** the service container starts and remains running.

2. **Given** a running service started via `hammerkit up`, **When** `hammerkit down` is executed, **Then** the service container stops.

### User Story 4 - Service-to-service and service-to-task dependencies (Priority: P3)

A developer has a service that depends on another service (via `needs`) and/or requires a task to run first (via `deps`). Hammerkit resolves the dependency chain before starting the dependent service.

**Why this priority**: Dependency chaining for services mirrors task dependencies and is a secondary but documented capability.

**Independent Test**: Declare two services where one lists the other in `needs`, and the first also lists a task in `deps`. Verify hammerkit runs the task first, then starts the dependency service, then the dependent service.

**Acceptance Scenarios**:

1. **Given** service `api` declares `deps: [install]` and `needs: [postgres]`, **When** a task needing `api` is run, **Then** hammerkit runs `install` first, then starts `postgres`, then starts `api`.

### Edge Cases

- A local task that `needs` a Kubernetes-forwarded service receives the same `HAMMERKIT_<NAME>_*` environment variables, but hammerkit does not provide DNS resolution for it.
- If no healthcheck is defined, hammerkit may start a dependent task before the service is fully ready.
- A service name is uppercased when constructing environment variable names (e.g. service `my-db` becomes `HAMMERKIT_MY_DB_HOST`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST start all services listed in a task's `needs` before executing that task.
- **FR-002**: System MUST expose services to container tasks via the container network using the service name as the DNS hostname.
- **FR-003**: System MUST inject `HAMMERKIT_<NAME>_HOST`, `HAMMERKIT_<NAME>_PORT`, and `HAMMERKIT_<NAME>_PORT_<containerPort>` environment variables into local tasks for each needed service, where `<NAME>` is the uppercased service name.
- **FR-004**: System MUST wait for a service's healthcheck command to exit with code 0 before launching any task that needs it, when a healthcheck is configured.
- **FR-005**: System MUST support `hammerkit up` to start services independently of task execution.
- **FR-006**: System MUST support `hammerkit down` to stop running services.
- **FR-007**: System MUST resolve service `deps` (tasks) and `needs` (other services) before starting a service, applying the same dependency-ordering rules as for tasks.
- **FR-008**: System MUST support both container services (image-based) and Kubernetes port-forwarding services within the same build file.

### Key Entities

- **Service**: A continuous, long-running process declared under the `services` key in a build file. Has a `name`, optional `needs` (other services), optional `deps` (tasks), and is either container-based or Kubernetes-based.
- **Healthcheck**: An optional check attached to a container service. Contains a `cmd` executed inside the service container; exit code 0 means ready.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A container task that `needs` a service starts only after that service is running (and its healthcheck passes, if present), verified across at least one postgres and one redis-style service.
- **SC-002**: A local task that `needs` a service receives the correct host/port environment variables, confirmed by the task process reading them and connecting successfully.
- **SC-003**: `hammerkit up` / `hammerkit down` start and stop services within a reasonable time, with no task execution triggered.
- **SC-004**: Service dependency chains (service needing another service, service needing a task) resolve in the correct order with zero manual intervention.

## Assumptions

- The service name used as the DNS hostname is exactly as declared in the build file (case-sensitive for the network alias; uppercased only for the environment variable injection).
- `HAMMERKIT_<NAME>_PORT` refers to the first/primary published port when a service exposes multiple ports.
- Services are automatically stopped when they are no longer needed by any remaining task in the current run, unless started with `hammerkit up`.
- The `--env` flag for selecting Kubernetes environments applies equally to Kubernetes-type services; container services are not environment-scoped.
