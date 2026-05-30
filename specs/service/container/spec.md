# Feature Specification: Service: Container

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/service/container.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Declaring a container service with a healthcheck (Priority: P1)

A developer needs a postgres database that is fully ready before any dependent task starts. They declare a container service with an `image`, optional environment variables, and a `healthcheck` command. Hammerkit starts the container and repeatedly executes the healthcheck inside it; when the command exits 0, dependent tasks are unblocked.

**Why this priority**: The healthcheck is the central correctness guarantee for container services — without it tasks may fail due to a not-yet-ready service.

**Independent Test**: Declare a postgres service with `healthcheck.cmd: "pg_isready -U postgres"`. Run a task that needs it and confirm the task only begins after `pg_isready` returns 0.

**Acceptance Scenarios**:

1. **Given** a container service with a `healthcheck` configured, **When** a task that needs the service is triggered, **Then** hammerkit does not start the task until the healthcheck command exits with code 0 inside the service container.

2. **Given** a container service with no `healthcheck`, **When** a task that needs it is triggered, **Then** hammerkit starts the task as soon as the container is running (without waiting for application readiness).

### User Story 2 - Exposing service ports to the host for debugging (Priority: P2)

A developer wants to connect a local SQL client to a running postgres service for inspection. They declare a `ports` mapping on the service so the container port is published to the host machine.

**Why this priority**: Port exposure is optional for task connectivity but commonly needed during development for direct access.

**Independent Test**: Declare a postgres service with `ports: [5432:5432]`. Start the service and verify that a connection to `localhost:5432` from the host succeeds.

**Acceptance Scenarios**:

1. **Given** a service declares `ports: - 5432:5432`, **When** the service is running, **Then** port 5432 on the host machine is forwarded to the service container.

2. **Given** no `ports` are declared on a service, **When** a container task that needs it runs, **Then** the task can still reach the service on all its container ports via the container network without any published ports.

### User Story 3 - Persisting service data across restarts with volumes (Priority: P2)

A developer wants database data to survive service restarts. They add a `volumes` entry mapping a named volume to the data directory inside the container.

**Why this priority**: Without volumes, container services lose all state on every stop/start cycle, which breaks local development workflows.

**Independent Test**: Declare a postgres service with a volume, seed it with data, stop and restart the service, and verify the data is still present.

**Acceptance Scenarios**:

1. **Given** a service declares a named volume (e.g. `postgres-db:/var/lib/postgresql/data`), **When** the service is stopped and restarted, **Then** data written during the first run is still available after restart.

### User Story 4 - Mounting local config files into a service container (Priority: P3)

A developer needs to supply a custom postgres configuration file. They declare a `mounts` entry to bind-mount the local file into the container at the expected path.

**Why this priority**: Mounts are an advanced configuration option; most services do not require them.

**Independent Test**: Declare a service with a mount pointing to a local config file. Start the service and verify the file is accessible at the mounted path inside the container.

**Acceptance Scenarios**:

1. **Given** a service declares `mounts: - "./postgres.conf:/etc/postgresql/postgresql.conf"`, **When** the service container starts, **Then** the file at `./postgres.conf` on the host is readable at `/etc/postgresql/postgresql.conf` inside the container.

### User Story 5 - Exporting and importing service volume data (Priority: P3)

A developer seeds a local database from a known-good snapshot using `hammerkit store` / `hammerkit restore` to export and import the service's volume data.

**Why this priority**: Store/restore for services is a power feature enabling reproducible environments and data sharing between teammates.

**Independent Test**: Run a service, write data, run `hammerkit store`, wipe the volume, run `hammerkit restore`, verify data is back.

**Acceptance Scenarios**:

1. **Given** a running service with volume data, **When** `hammerkit store` is executed for that service, **Then** the volume data is exported to a transferable archive.

2. **Given** an exported archive, **When** `hammerkit restore` is executed, **Then** the service volume is populated with the archived data.

### Edge Cases

- A service without a healthcheck may start a dependent task before the service application is ready to accept connections.
- Mounts of large or frequently changing directories on macOS and Windows incur significant CPU overhead due to filesystem sync; volumes are preferred for data.
- A service is stopped automatically when no further tasks in the current run require it (unless kept alive via `hammerkit up`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST start container services using the specified `image`.
- **FR-002**: System MUST pass declared `envs` as environment variables into the service container.
- **FR-003**: System MUST publish declared `ports` mappings from the service container to the host machine.
- **FR-004**: System MUST execute the `healthcheck.cmd` inside the service container and only unblock dependent tasks once it exits with code 0.
- **FR-005**: System MUST mount declared `volumes` (named volumes and bind paths) into the service container to persist data across restarts.
- **FR-006**: System MUST bind-mount declared `mounts` (host path to container path) into the service container.
- **FR-007**: System MUST make all container ports of a service reachable from other container tasks in the same network, regardless of whether `ports` are published to the host.
- **FR-008**: System MUST support store/restore operations on service volumes via the `hammerkit store` and `hammerkit restore` CLI commands.

### Key Entities

- **Container Service**: A service with an `image`, optional `envs`, `ports`, `healthcheck`, `volumes`, and `mounts`.
- **Healthcheck**: Contains a `cmd` string executed inside the service container. A zero exit code signals readiness.
- **Volume**: A named or path-based Docker volume entry mapping a volume identifier to a container path.
- **Mount**: A bind-mount entry mapping a host file/directory path to a container path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task dependent on a service with a healthcheck does not start until the healthcheck exits 0, verified by log timestamps.
- **SC-002**: A declared port mapping results in a reachable port on the host machine while the service is running.
- **SC-003**: Data written to a volume-backed service directory is present after the service container is stopped and restarted.
- **SC-004**: A bind-mounted file is readable at its declared container path when the service container is inspected.
- **SC-005**: `hammerkit store` produces a restorable artifact and `hammerkit restore` repopulates the volume to a matching state.

## Assumptions

- Container services run within the same Docker network as container tasks; no additional network configuration is needed for inter-container communication.
- The `healthcheck.cmd` is a shell command string executed inside the service container (not on the host).
- Services sharing volumes across multiple hammerkit projects run as a single container instance, not duplicated per project.
- `ports` are not required for container tasks to reach the service — they are solely for host-side access.
