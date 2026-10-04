# Feature Specification: Service Hostname, Host Ports on Up, Read-only Mounts

**Feature Branch**: `release/1.11.0`

**Created**: 2026-10-04

**Status**: Implemented

**Input**: Migration feedback — a single-member MongoDB replica set needs a member address that the service itself and its clients resolve; with links only, the service could not resolve its own name, so the member had to be its IP and be reconfigured whenever the container restarted with a new one. One set of infrastructure services shared by development (`hammerkit up`, host ports) and CI runs would collide on host ports. Configuration and secret mounts could only be writable.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A service resolves its own name (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a service `db`, **When** a process inside it connects to `db`, **Then** it reaches its own container (Docker: container hostname; Kubernetes: pod `hostname`).
2. **Given** a service name that is not a DNS label (`lib:Data_Base`), **Then** its hostname is the sanitised label (`lib-data-base`).

### User Story 2 - Host ports only where the host needs them (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a service with `ports`, **When** it runs through `hammerkit up`, **Then** the ports are published.
2. **Given** the same service needed only by container tasks in `hammerkit run`, **Then** no host port is published and the tasks still reach it.
3. **Given** a local task that needs the service, **When** `hammerkit run` starts it, **Then** the ports are published (the `HAMMERKIT_<NAME>_PORT` hints point at them).

### User Story 3 - Read-only mounts and volumes (Priority: P2)

**Acceptance Scenarios**:

1. **Given** `host:container:ro` in `mounts`, **Then** the container sees the path read-only; `:rw` or no third part stays writable; any other third part is an error.
2. **Given** `name:path:ro` or `{ path, name, readOnly: true }` in `volumes`, **Then** the volume is mounted read-only (Kubernetes `readOnly: true`).

## Requirements _(mandatory)_

- **FR-001**: Docker `Hostname` and Kubernetes pod `hostname` are the sanitised service name.
- **FR-002**: Port bindings are created when the run is `up`, or when a local task requires the service.
- **FR-003**: Read-only binds get `:ro` on Docker and `readOnly` on Kubernetes volume mounts. None of these change the cache identity of tasks.
