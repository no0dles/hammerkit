# Feature Specification: CLI: down

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/down.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stopping all running services (Priority: P1)

A developer has finished their work session and wants to free the resources held by services that were started with `hammerkit up` (foreground or daemon). They run `hammerkit down` and all services defined in the build file are stopped.

**Why this priority**: `down` is the natural complement to `up` and the primary way to cleanly release containerized service resources.

**Independent Test**: Start services with `hammerkit up --daemon`, then run `hammerkit down` and verify that all service containers are no longer running.

**Acceptance Scenarios**:

1. **Given** services started with `hammerkit up --daemon`, **When** the user runs `hammerkit down`, **Then** all services defined in the build file are stopped and exit cleanly.

2. **Given** services started with `hammerkit up` (foreground, now interrupted), **When** the user runs `hammerkit down`, **Then** any remaining service containers are stopped.

3. **Given** no services currently running, **When** the user runs `hammerkit down`, **Then** the command exits with code 0 without error.

### User Story 2 - Stopping a subset of services by label (Priority: P2)

A developer is running multiple services and wants to stop only a specific subset without affecting others. They use `--filter` or `--exclude` to target the relevant services.

**Why this priority**: Label filtering is consistent across all service-related commands and supports fine-grained lifecycle control in complex builds.

**Independent Test**: Start two labeled services, run `hammerkit down -f <label>` matching only one, and verify the other remains running.

**Acceptance Scenarios**:

1. **Given** multiple services with different labels, **When** the user runs `hammerkit down -f <label>`, **Then** only services matching the label are stopped; others remain running.

2. **Given** multiple services with different labels, **When** the user runs `hammerkit down -e <label>`, **Then** services matching the excluded label are not stopped; all others are stopped.

### User Story 3 - Stopping services in a named environment (Priority: P3)

A developer has services running in a Kubernetes environment and wants to stop them without affecting local Docker services. They pass `--env <name>` to target that environment.

**Why this priority**: Multi-environment support is consistent with `up` but is a power-user scenario.

**Independent Test**: Given services running in a named Kubernetes environment, run `hammerkit down --env <name>` and verify those services stop while local Docker services are unaffected.

**Acceptance Scenarios**:

1. **Given** services running in a named environment, **When** the user runs `hammerkit down --env <name>`, **Then** services in that environment are stopped.

### Edge Cases

- `hammerkit down` with no running services must not error.
- `hammerkit down -f <label>` where no services match the label must exit with code 0 without affecting other services.
- `--filter` and `--exclude` used together must apply both constraints; services matching both conditions are excluded.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST stop all services defined in the build file when `hammerkit down` is run without filter options.
- **FR-002**: System MUST support label-based inclusion filtering via `-f / --filter <key=value>` to stop only matching services.
- **FR-003**: System MUST support label-based exclusion filtering via `-e / --exclude <key=value>` to skip stopping matching services.
- **FR-004**: System MUST support an `--env <name>` option to stop services in a configured named environment.
- **FR-005**: System MUST exit with code 0 when no services are running (idempotent stop).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `hammerkit down`, no service containers defined in the build file remain in a running state.
- **SC-002**: `hammerkit down` exits with code 0 regardless of whether services were running before the command.
- **SC-003**: With `-f <label>`, only services bearing that label are stopped; services with other labels continue running.
- **SC-004**: With `--env <name>`, only services in the named environment are stopped; services in other environments are unaffected.

## Assumptions

- `hammerkit down` targets the same set of services as the corresponding `hammerkit up` invocation when no filters are applied.
- The command does not require that services were started specifically via `hammerkit up`; it stops matching service containers regardless of how they were started.
- `down` has no `--daemon`, `--concurrency`, `--watch`, `--log`, or `--cache` options (these do not appear in the documented option list).
- Stopping a service that is not running is treated as a success (idempotent), consistent with the "no error on empty" edge case documented implicitly.
