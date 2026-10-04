# Feature Specification: Service Init (a Task Run Once the Service Is Ready)

**Feature Branch**: `release/1.11.0`

**Created**: 2026-10-04

**Status**: Implemented

**Input**: Migration feedback — Compose stacks set services up with one-shot containers (`createbuckets`, `rs.initiate`, assigning roles in an identity provider) that run once the service is healthy. Without that concept the setup hid in healthchecks or in a helper service looping `sleep` whose healthcheck did the work. Review feedback: an inline init block repeats a subset of task fields; the init should be a task, with everything a task has.

## User Scenarios & Testing _(mandatory)_

1. **Given** a service with `init: <task>`, **When** the service passed its healthcheck, **Then** the task runs, reaching the service by its name, and only afterwards does anything else needing the service start.
2. **Given** the init task fails (non-zero exit, error or timeout), **Then** the service fails, nothing needing it runs, and the run fails.
3. **Given** an init task without its own `timeout`, **Then** it gets `HAMMERKIT_INIT_TIMEOUT`, else 5 minutes.
4. **Given** `up --daemon --wait start`, **Then** a service with an init is still awaited (the init needs a ready service).
5. **Given** the service starts again in a later run, **Then** the init runs again (it should be idempotent); a service reused from `up --daemon` does not run it again.
6. **Given** the init task is asked for by name, **Then** it runs once: as the init when the service starts for it, or against the running service when it was reused.

## Requirements _(mandatory)_

- **FR-001**: `init` names a task like `deps` (`name` or `prefix:name`); the task is planned like any other and may be a container or local task with `deps`, `needs`, `envs`, `secrets`, `mounts`, `extend`.
- **FR-002**: The init task needs the service under the service's name without declaring it, through a view of the service that runs once the healthcheck passed. The service runs for everything else once the init succeeded. The init task is not a requirer of the service (it never makes the service start), except when it is asked for alone.
- **FR-003**: The init task is never a cache hit (`cache: none`), also when it declares no `cache` of its own: neither the run's default method nor `--cache` turns caching back on, since its effect lives in the service, which a later run may have recreated. Its id is part of the service's definition hash, so a changed init recreates a running service.
- **FR-004**: A service in a run brings its init task into the run; an init task whose service does not start in the run completes as skipped.
