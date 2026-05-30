# Feature Specification: CLI: up

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/up.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Starting shared services for local development (Priority: P1)

A developer needs a database running continuously while they iterate on several tasks. Instead of letting each task start and stop the database automatically, they run `hammerkit up` to start all services and keep them alive. When they are done for the day, they run `hammerkit down`.

**Why this priority**: Persistent service management during development is the primary use case for the `up` command; it directly reduces the startup overhead between task runs.

**Independent Test**: Given a build file with a service (e.g., `postgres`), run `hammerkit up` and verify the service container is running and remains running until the process is interrupted or `hammerkit down` is called.

**Acceptance Scenarios**:

1. **Given** a build file with one or more services, **When** the user runs `hammerkit up`, **Then** all services start and the process blocks until the user sends an interrupt signal (Ctrl+C or equivalent).

2. **Given** a build file with one or more services, **When** the user runs `hammerkit up --daemon`, **Then** all services start in the background and the command returns immediately with exit code 0.

3. **Given** services started with `hammerkit up --daemon`, **When** the user subsequently runs `hammerkit down`, **Then** those services are stopped.

4. **Given** a build file with multiple services and only some bearing a specific label, **When** the user runs `hammerkit up -f <label>`, **Then** only the services matching the label are started.

5. **Given** a build file with multiple services and some bearing an excluded label, **When** the user runs `hammerkit up -e <label>`, **Then** services matching the excluded label are not started.

### User Story 2 - Starting services in a named environment (Priority: P2)

A developer wants to start services inside a Kubernetes cluster configured under `environments:` in their build file. They pass `--env <name>` to target that environment instead of the local Docker runtime.

**Why this priority**: Multi-environment support is an important power-user scenario but not required for local Docker-based development.

**Independent Test**: Given a build file with a named Kubernetes environment, run `hammerkit up --env <name>` and verify that service start commands target the configured environment.

**Acceptance Scenarios**:

1. **Given** a named environment declared in the build file, **When** the user runs `hammerkit up --env <name>`, **Then** services are started within that environment's runtime.

### Edge Cases

- Running `hammerkit up` when no services are defined in the build file should exit cleanly (code 0) with an informational message.
- Running `hammerkit up --daemon` multiple times for already-running services should either be idempotent or report that services are already running.
- Interrupt signal during foreground `up` must cleanly stop the started services before exiting.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST start all services defined in the build file when `hammerkit up` is run without filter options.
- **FR-002**: System MUST keep services running and block the terminal until interrupted, unless `--daemon` is supplied.
- **FR-003**: System MUST start services in the background and return immediately when `--daemon` is supplied.
- **FR-004**: System MUST support label-based inclusion filtering via `-f / --filter <key=value>` to start only matching services.
- **FR-005**: System MUST support label-based exclusion filtering via `-e / --exclude <key=value>` to skip matching services.
- **FR-006**: System MUST support an `--env <name>` option to start services in a configured named environment.
- **FR-007**: System MUST support `-c / --concurrency <number>`, `-w / --watch`, `--cache <method>`, and `-l / --log <mode>` options (consistent with the `run` command option surface).

### Key Entities

- **Service**: A long-running container (e.g., a database) declared in the build file under `services:`, started and kept running by `up`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `hammerkit up` (foreground), the service container is reachable on its declared port while the process is running.
- **SC-002**: After `hammerkit up --daemon`, the command exits with code 0 and the service container is reachable on its declared port.
- **SC-003**: With `-f <label>`, only services bearing that label are started; other services remain stopped.
- **SC-004**: Services started with `hammerkit up` are stopped when the foreground process receives an interrupt signal.

## Assumptions

- Services that are already running (e.g., started by a prior `up` invocation) are handled gracefully; exact behavior (skip, restart, error) is an implementation detail not specified in the docs.
- The `--watch` and `--cache` flags carry over from the `run` command option surface and apply to any tasks that services might trigger; their exact effect on pure-service `up` runs is not specified in the docs and assumed to be a no-op for services themselves.
- `--env` targets named environments declared under the `environments:` key in the build file (informed by the cross-reference to the Kubernetes doc).
