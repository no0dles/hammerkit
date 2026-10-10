# Feature Specification: Export Outputs of a Failing Task

**Feature Branch**: `release/1.11.0`

**Created**: 2026-10-04

**Status**: Implemented

**Input**: Migration feedback — an end-to-end test task records videos only for failing specs, but exported outputs were copied to the host only when the task succeeded, so CI never received the videos it needed.

## User Scenarios & Testing _(mandatory)_

1. **Given** a container task with an output `{ path: report, export: always }`, **When** a command exits non-zero, **Then** the task fails and `report` is copied to the host.
2. **Given** an output with `export: true`, **When** the task fails, **Then** it is not copied (unchanged behaviour).
3. **Given** `export: always`, **When** the task succeeds, **Then** it is copied like `export: true`.

## Requirements _(mandatory)_

- **FR-001**: `generates[].export` accepts `true`, `false` or `always`.
- **FR-002**: On a non-zero exit, Docker copies the `always` outputs before the container is removed; timeouts and cancellations copy nothing.
- **FR-003**: A failed task is never cached; cache identity is unchanged.
- **FR-004**: Kubernetes copies no outputs to the host for either form (unchanged).
