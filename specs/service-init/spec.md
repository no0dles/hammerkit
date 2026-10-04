# Feature Specification: Service Init (One-shot After Ready)

**Feature Branch**: `release/1.11.0`

**Created**: 2026-10-04

**Status**: Implemented

**Input**: Migration feedback — Compose stacks set services up with one-shot containers (`createbuckets`, `rs.initiate`, assigning roles in an identity provider) that run once the service is healthy. Without that concept the setup hid in healthchecks or in a helper service looping `sleep` whose healthcheck did the work.

## User Scenarios & Testing _(mandatory)_

1. **Given** a service with `init: { image, cmds, mounts, envs }`, **When** the service passed its healthcheck, **Then** a container of `init.image` (default: the service's image) runs the commands to completion, reaching the service by its name, and only afterwards does anything needing the service start.
2. **Given** an init command exits non-zero, **Then** the service ends as crashed with "init of <service> failed with exit code N", and nothing needing it runs.
3. **Given** an init that doesn't finish within `init.timeout` (else `HAMMERKIT_INIT_TIMEOUT`, else 5 minutes), **Then** it is stopped and the service fails with a timeout message.
4. **Given** `up --daemon --wait start`, **Then** a service with an init is still awaited (the init needs a ready service).
5. **Given** the service restarts, **Then** the init runs again (it should be idempotent).

## Requirements _(mandatory)_

- **FR-001**: `init` takes `image`, `shell` (default `sh`), `cmds`, `envs` (merged over the service's), `mounts` (incl. `:ro`) and `timeout`.
- **FR-002**: The init runs through the runtime's container task path: Docker linked to the service and its needs; Kubernetes as a Job with `hostAliases` for them (Kubernetes task Jobs now get `hostAliases` for their needs, and run their commands through the task's shell like Docker).
- **FR-003**: The init is part of the service's definition hash, so a changed init recreates a running service.
