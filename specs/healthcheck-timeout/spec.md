# Feature Specification: Healthcheck Timeout

**Feature Branch**: `feat/healthcheck-timeout`

**Created**: 2026-10-03

**Status**: Implemented

**Input**: Migration feedback — moving a Compose test stack (MongoDB, Elasticsearch, RabbitMQ, MinIO, an app) to hammerkit services, every mistake in a healthcheck (wrong quoting, wrong user, `localhost` resolving to IPv6) left the run waiting forever with no hint which service was stuck. Compose has `start_period`/`timeout`/`retries`; hammerkit polled without a deadline.

## Motivation

A healthcheck that never passes blocked the dependent task until someone cancelled the run. In CI that burns the job's whole time limit; locally it looks like a hang. A readiness deadline turns that into a failure that names the service and the command that never passed.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Fail a service that never becomes ready (Priority: P1)

A developer's service healthcheck never exits `0`. After the deadline (default 20 seconds) the service fails, the dependent tasks don't start and the run reports which service and which command didn't pass.

**Independent Test**: `examples/service-healthcheck-timeout` (a `sleep 600` container whose healthcheck `test -f /ready` never passes, `timeout: 2s`) fails within seconds with the timeout message.

**Acceptance Scenarios**:

1. **Given** a service whose healthcheck never passes, **When** a task needs it, **Then** the service ends as crashed after its timeout and the run fails with a message naming the service, the healthcheck command and the timeout.
2. **Given** a service whose healthcheck passes before the deadline, **When** a task needs it, **Then** the timeout has no effect.

### User Story 2 - Slow services (Priority: P1)

A developer runs Elasticsearch, which takes longer than 20 seconds to start. They set `healthcheck.timeout: 90s` on that service.

**Acceptance Scenarios**:

1. **Given** `healthcheck.timeout` on a service, **When** it is planned, **Then** that value is its deadline.
2. **Given** no `healthcheck.timeout` and `HAMMERKIT_HEALTHCHECK_TIMEOUT` set, **When** it is planned, **Then** the environment value is the deadline for every such service (a slow CI machine raises all of them at once).
3. **Given** an invalid `HAMMERKIT_HEALTHCHECK_TIMEOUT`, **When** the build is planned, **Then** planning fails naming the variable.

## Requirements _(mandatory)_

- **FR-001**: `healthcheck` accepts an optional `timeout` in the same duration format as the task `timeout` (`20s`, `2m`, …).
- **FR-002**: The deadline is resolved as `healthcheck.timeout`, else `HAMMERKIT_HEALTHCHECK_TIMEOUT`, else `20s`.
- **FR-003**: Docker: the clock starts when the container is started; the healthcheck is retried about once a second until it passes or the deadline passes.
- **FR-004**: Kubernetes: the clock starts once a pod of the deployment (`hammerkit.dev/id=<service id>`) is `Running` — image pulls and scheduling don't count against it.
- **FR-005**: The failure message names the service, the healthcheck command and the timeout, and points at `healthcheck.timeout` / `HAMMERKIT_HEALTHCHECK_TIMEOUT`.
- **FR-006**: The timeout is not part of the service's cache identity (it changes when a run fails, not what a ready service is).

## Success Criteria _(mandatory)_

- **SC-001**: A never-ready service fails in about its timeout instead of hanging (integration test: 2s timeout, fails in under 5s).
- **SC-002**: Existing services that become ready within 20 seconds behave as before.
