# Feature Specification: `up --wait` and Recreating Changed Services

**Feature Branch**: `release/1.11.0`

**Created**: 2026-10-04

**Status**: Implemented

**Input**: Migration feedback — a script starting the development services with `up --daemon` wanted control over when it continues (some callers poll readiness themselves), and a running service kept its old command, env or mounts after the build file changed until it was stopped by hand.

## User Scenarios & Testing _(mandatory)_

1. **Given** `up --daemon` (or `--wait ready`), **Then** it returns once every service passed its healthcheck (unchanged behaviour).
2. **Given** `up --daemon --wait start`, **Then** it returns once the containers started, without waiting for the healthchecks of services nothing else in the run needs; a service another service needs is still awaited.
3. **Given** a running service whose image, command, env values, ports, mounts, volumes, healthcheck or needed services changed, **When** `up` or `run` starts it, **Then** the running container is removed and recreated; an unchanged service is reused.

## Requirements _(mandatory)_

- **FR-001**: `up --wait <ready|start>`, default `ready`.
- **FR-002**: Service containers carry a `hammerkit-definition` label: a hash of the definition and of the definitions of the services it needs (a dependent links to the container it started with). Values are never stored, only the hash.
- **FR-003**: A running container whose label differs from the current definition is removed before the service starts.
