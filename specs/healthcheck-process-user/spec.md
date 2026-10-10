# Feature Specification: Healthcheck as the Service Process User

**Feature Branch**: `fix/healthcheck-process-user`

**Created**: 2026-10-03

**Status**: Implemented

**Input**: Real-world migration of a Docker Compose e2e stack to hammerkit services. A RabbitMQ service with the common healthcheck `rabbitmq-diagnostics -q check_port_connectivity` never started: hammerkit ran the check immediately and as root; the CLI created `/var/lib/rabbitmq/.erlang.cookie` owned by root before the server (which the image's entrypoint drops to user `rabbitmq`) did, and the server then failed with `Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces`. Reproduced with hammerkit 1.8.0 on `rabbitmq:3.13-alpine`.

## Motivation

A healthcheck should observe a service, not change it. On Docker hammerkit execed the check with the exec default user (root for most images) from the moment the container started, so a check could create state as root that the service process — often running as an unprivileged user after its entrypoint drops privileges — cannot use. Kubernetes exec probes run as the container's user; the Docker runtime did not match.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Healthchecks don't interfere with the service (Priority: P1)

**Independent Test**: `examples/service-healthcheck-user` — RabbitMQ with `rabbitmq-diagnostics -q check_port_connectivity` becomes ready and a task needing it runs (`src/testing/integration/service-healthcheck-user.spec.ts`). With 1.8.0 the same example fails with the cookie `eacces`.

**Acceptance Scenarios**:

1. **Given** a service whose main process runs as a non-root user, **When** its healthcheck runs, **Then** it runs as that user (`uid:gid` of PID 1, read from `/proc/1/status` inside the container).
2. **Given** a service, **When** it starts, **Then** the first healthcheck runs one interval (1s) after the container starts, not immediately.
3. **Given** an image without `cat` (or a Windows container), **When** the user can't be read, **Then** the check runs as the exec default, as before.

## Requirements

- **FR-001**: The Docker runtime runs each healthcheck as the effective `uid:gid` of the container's PID 1, read inside the container (correct under user namespaces and rootless Docker).
- **FR-002**: The first healthcheck runs one interval after the container starts.
- **FR-003**: Kubernetes is unchanged: exec probes already run as the container's user.
