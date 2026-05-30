# Feature Specification: Task: Caching

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/caching.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Skip unchanged tasks automatically (Priority: P1)

A developer runs their build repeatedly. Tasks whose source files have not changed since the last successful run are detected as up-to-date and skipped, saving time.

**Why this priority**: Caching is the primary mechanism that makes hammerkit practical for incremental development workflows.

**Independent Test**: Run a task with `src` defined twice with no file changes; confirm the second run reports the task as skipped and no commands execute.

**Acceptance Scenarios**:

1. **Given** a task with `src` files defined, **When** those files have not changed since the last successful run, **Then** the task is skipped.
2. **Given** a task with `src` files defined, **When** at least one source file has changed, **Then** the task re-executes.
3. **Given** a task whose dependency has no `src` defined (always runs), **When** the downstream task has `src` defined, **Then** the downstream task is also executed (cannot be skipped when an upstream task was not skipped).

### User Story 2 - Choose a cache method per task (Priority: P2)

A developer wants finer control over how staleness is detected. They set `cache: modify-date` on a task to use file modification timestamps instead of content checksums, or `cache: none` to disable caching for a specific task.

**Why this priority**: Different tasks have different performance/correctness trade-offs for cache detection.

**Independent Test**: Set `cache: none` on a task with `src` defined and verify it always re-executes regardless of source changes.

**Acceptance Scenarios**:

1. **Given** `cache: checksum` on a task, **When** source file content is identical but the modification timestamp has changed, **Then** the task is skipped.
2. **Given** `cache: modify-date` on a task, **When** a source file's modification timestamp has changed, **Then** the task re-executes even if content is the same.
3. **Given** `cache: none` on a task, **When** the task is invoked, **Then** it always re-executes regardless of source state.

### User Story 3 - Override the default cache method globally at runtime (Priority: P2)

A CI engineer wants to run all tasks with checksum-based caching regardless of the per-task defaults. They pass `--cache checksum` on the CLI to override the default for all tasks that did not set an explicit cache method.

**Why this priority**: CI environments benefit from a reliable, content-based cache independent of local developer machine defaults.

**Independent Test**: Run with `--cache none` and verify all tasks without an explicit `cache` field re-execute.

**Acceptance Scenarios**:

1. **Given** tasks with no explicit `cache` field, **When** `hammerkit build --cache modify-date` is run, **Then** all those tasks use modify-date caching.
2. **Given** a task with an explicit `cache: checksum`, **When** `hammerkit build --cache modify-date` is run, **Then** that task continues to use checksum caching (explicit value wins).

### User Story 4 - Use a remote cache backend to share results across machines (Priority: P3)

A team wants CI and developer machines to share build results. They declare a named cache in the build file with an S3 backend and reference it from their tasks. Hammerkit pulls a cached result before running the task and pushes a new result after a successful run.

**Why this priority**: Remote caching eliminates redundant work in distributed teams and CI/CD pipelines.

**Independent Test**: Configure an S3-backed cache, run the task on one machine, then run on a second machine that has not built locally and confirm the task is skipped via the remote cache.

**Acceptance Scenarios**:

1. **Given** a task with a named cache pointing to a remote backend, **When** a matching cache entry exists remotely, **Then** hammerkit pulls the result and skips task execution.
2. **Given** a task with a named cache pointing to a remote backend, **When** no matching entry exists remotely and the task runs successfully, **Then** hammerkit pushes the result to the remote backend.

### Edge Cases

- Source glob patterns using `**` do not traverse symlinked directories.
- Using a large directory such as `node_modules` as a source is explicitly discouraged because recursive traversal is expensive.
- A task can only be skipped if all of its dependencies before it were also skipped; a single non-skipped ancestor forces the task to re-execute.
- The default cache method is `modify-date` locally and `checksum` in CI (environment-dependent).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a `src` list of files, directories, and glob patterns on a task and use them to determine skip eligibility.
- **FR-002**: The system MUST skip a task when all its sources are unchanged and all its dependency tasks were also skipped.
- **FR-003**: The system MUST support three cache methods: `checksum` (content hash), `modify-date` (file mtime), and `none` (always execute).
- **FR-004**: The system MUST support a `cache` field on a task accepting either a shorthand method string or an object with `name` and optional `method` fields.
- **FR-005**: The system MUST support a `--cache <method>` CLI flag that sets the default method for all tasks that did not declare an explicit `cache` field.
- **FR-006**: An explicit `cache` value on a task MUST take precedence over the `--cache` flag.
- **FR-007**: The system MUST support named caches with remote backends (at minimum S3 and S3-compatible stores).
- **FR-008**: When a remote cache backend is configured and a cache hit exists remotely, the system MUST pull and restore the result without executing the task.
- **FR-009**: After a successful task run with a remote backend, the system MUST push the result to the remote backend.
- **FR-010**: Glob patterns in `src` MUST support the node-glob pattern set including `*`, `?`, `[...]`, `!(…)`, `?(…)`, `+(…)`, `*(…)`, `@(…)`, and `**`.

### Key Entities

- **Cache entry**: A record of a successful task run keyed by source fingerprint, associated with a cache method and optionally a named backend.
- **Named cache**: A top-level `caches` declaration with an optional remote backend (`local` or `s3`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task with unchanged sources is skipped on the second consecutive run with zero commands executed.
- **SC-002**: Changing a single source file causes exactly the affected task (and its dependents) to re-execute on the next run.
- **SC-003**: `--cache none` causes all tasks without an explicit `cache` field to execute unconditionally.
- **SC-004**: With an S3 remote backend, a task result produced on machine A is reused on machine B without re-executing the task commands.

## Assumptions

- The environment-dependent default (modify-date locally, checksum in CI) is determined by whether hammerkit detects a CI environment variable (e.g., `CI=true`).
- Redeclaring the built-in `default` cache to use a remote backend affects all tasks that reference the default cache, as described in the build-file caches documentation.
- The `s3` backend covers S3-compatible stores (MinIO, Cloudflare R2, Google Cloud Storage); no additional backend types are documented for 1.6.0.
