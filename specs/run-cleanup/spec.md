# Feature Specification: Run Cleanup

**Feature Branch**: `fix/cleanup`

**Created**: 2026-10-03

**Status**: Implemented

**Input**: Migration feedback — after migrating a CI with a Compose test stack, `docker ps` was full of paused task containers, services kept running after the run was stopped, and a local task (`cypress-ci.sh`) outlived `hammerkit run`.

## Findings

- Container tasks were paused, not removed, as the record of their state (ADR 0007).
- Aborting a run with a service crashed hammerkit: `awaitNoRequirements(...).then(stop)` had no rejection handler, so the `AbortError` was an unhandled rejection and Node exited before any `finally` removed the service container.
- Only `SIGINT` aborted a run. `SIGTERM` and `SIGHUP` made Node exit at once; local tasks run in their own process group, so they were orphaned.
- A local command ignoring `SIGTERM` kept running after the abort.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Nothing left after a run (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a container task that succeeded, **When** the run ends, **Then** no container of it exists and the next run is a cache hit (`container-cleanup.spec.ts`).
2. **Given** paused records of an older hammerkit, **When** their task runs again, **Then** they are removed.

### User Story 2 - Stopping a run (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a run with a service and a local task, **When** hammerkit gets `SIGINT`, `SIGTERM` or `SIGHUP`, **Then** it exits without crashing, the service container is removed and the local task's process group is gone (verified with the built CLI).
2. **Given** a local command that ignores `SIGTERM`, **When** the run is aborted, **Then** its group is killed after `HAMMERKIT_STOP_TIMEOUT_MS` (default 10s) (`execute-command.spec.ts`).

### User Story 3 - Clean up after a killed run (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a run killed with `SIGKILL`, **When** `hammerkit clean` runs in any project on the same machine, **Then** the run's containers are removed.
2. **Given** a service started with `up --daemon`, a container of a live hammerkit process or of another machine, **When** `clean` runs, **Then** it stays (`remove-orphaned-containers.spec.ts`).

## Requirements _(mandatory)_

- **FR-001**: A container task's container is removed when the task ends, whatever the outcome; its state is recorded in `<hammerkit directory>/state/<instance id>`.
- **FR-002**: `SIGINT`, `SIGTERM` and `SIGHUP` abort the run.
- **FR-003**: An abort sends `SIGTERM` to each local command's process group and `SIGKILL` to what is left after `HAMMERKIT_STOP_TIMEOUT_MS`.
- **FR-004**: Containers are labelled with `hammerkit-pid`, `hammerkit-host` and, for services, `hammerkit-daemon`; `clean` removes those of dead processes of this host (not daemon services) and paused pre-1.9 records.
