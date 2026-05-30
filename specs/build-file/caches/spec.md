# Feature Specification: Build File: Caches

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/build-file/caches.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Skip unchanged tasks using the default local cache (Priority: P1)

A developer runs hammerkit for the first time. Results are stored in the local cache (`~/.hammerkit/remote-cache`). On subsequent runs, hammerkit compares source file checksums and skips tasks whose inputs have not changed, saving build time without any configuration.

**Why this priority**: Local caching is the out-of-the-box experience for every hammerkit user; it is always active.

**Independent Test**: Run a task twice without modifying source files. Confirm the second run skips execution. Modify a source file and confirm the task runs again.

**Acceptance Scenarios**:

1. **Given** a task with `src:` files that have not changed since the last run, **When** the task is invoked, **Then** hammerkit skips execution and reports the task as up-to-date.
2. **Given** a task with `src:` files where at least one has changed, **When** the task is invoked, **Then** hammerkit executes the task commands.

### User Story 2 - Share build results across machines via a remote cache (Priority: P1)

A team uses an S3 bucket as a shared cache. When a developer or CI job completes a task, the result is pushed to S3. The next machine to request the same task pulls the cached result and skips execution, dramatically reducing CI time.

**Why this priority**: Remote caching is the primary new capability in 1.6.0 and a key differentiator for team and CI workflows.

**Independent Test**: Declare an S3-backed cache, run a task on machine A and confirm the result is pushed. On machine B (with empty local cache), run the same task and confirm it is pulled and skipped.

**Acceptance Scenarios**:

1. **Given** a named cache with `type: s3` is declared and a task references it, **When** a task completes successfully, **Then** the result is pushed to the configured S3 bucket.
2. **Given** the S3 bucket contains a cached result for the current source checksum, **When** the task is invoked on a machine without a local result, **Then** hammerkit pulls from the bucket and skips task execution.
3. **Given** the S3 backend is unreachable, **When** a task runs, **Then** hammerkit emits a warning and continues — the pull or push failure does NOT fail the build.

### User Story 3 - Override the default cache for all tasks (Priority: P2)

A team wants all tasks to use a remote S3 bucket without modifying each task individually. They declare a `caches.default` entry in the build file, redirecting the implicit default cache to their S3 bucket.

**Why this priority**: This is the recommended way to enable remote caching for an entire project with a single configuration change.

**Independent Test**: Declare `caches.default` pointing to S3, run several tasks that do not explicitly reference any cache, and confirm each pushes results to the S3 bucket.

**Acceptance Scenarios**:

1. **Given** `caches.default` is declared with an S3 backend, **When** a task that does not reference any named cache runs and succeeds, **Then** its result is pushed to the S3 bucket specified in `caches.default`.

### User Story 4 - Choose a change-detection method for a cache (Priority: P2)

A developer with a large source tree wants faster change detection. They configure a named cache to use `modify-date` instead of `checksum`. A CI workflow that must always rebuild configures a cache with `none` method.

**Why this priority**: Method selection lets users trade precision for speed or disable skipping entirely for correctness-critical pipelines.

**Independent Test**: Configure a task with `method: none`; run it twice and confirm it always executes. Configure a task with `method: modify-date`; run it twice without touching files and confirm it is skipped.

**Acceptance Scenarios**:

1. **Given** a cache with `method: none`, **When** any task using that cache is invoked, **Then** the task always executes, regardless of source file state.
2. **Given** a cache with `method: checksum` (default), **When** source file content is identical to the previous run, **Then** the task is skipped.
3. **Given** a cache with `method: modify-date`, **When** source file modification timestamps are unchanged, **Then** the task is skipped without computing checksums.

### Edge Cases

- Two built-in caches are always available: `default` (local backend, checksum method) and `none` (disables skipping).
- Declaring `caches.default` overrides the built-in `default` cache for all tasks that do not explicitly reference a cache.
- The `--cache` CLI flag overrides the method for implicit (non-explicitly-referenced) tasks at runtime and takes precedence over what `caches.default` declares for the method.
- S3 credentials are never stored in the build file; they are read from the AWS SDK credential chain.
- Azure Blob Storage is explicitly unsupported through the built-in `s3` backend.
- Any S3-compatible service (MinIO, Cloudflare R2, GCS via HMAC keys) can be used via the `endpoint` field.
- `forcePathStyle` defaults to `true` when a custom `endpoint` is set.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The build file MUST support a top-level `caches:` map where each entry declares a named cache with a `method` and a `backend`.
- **FR-002**: Each cache entry MUST support a `method` field with values `checksum` (default), `modify-date`, or `none`.
- **FR-003**: Each cache entry MUST support a `backend` field specifying the storage backend type (`local` or `s3`).
- **FR-004**: The `local` backend MUST accept an optional `path` field; when omitted it MUST default to `~/.hammerkit/remote-cache`.
- **FR-005**: The `s3` backend MUST require a `bucket` field and accept optional `region`, `endpoint`, `prefix`, and `forcePathStyle` fields.
- **FR-006**: S3 credentials MUST be sourced from the AWS SDK credential chain and MUST NOT be stored in the build file.
- **FR-007**: Before a task runs, the system MUST attempt to pull a cached result from the backend if no local result is present; if the sources are unchanged, the task MUST be skipped.
- **FR-008**: After a task completes successfully, the system MUST push the result to the configured backend.
- **FR-009**: Backend errors during pull or push MUST emit a warning and MUST NOT cause the build to fail.
- **FR-010**: Declaring `caches.default` MUST override the built-in default cache for all tasks that do not explicitly reference a named cache.
- **FR-011**: A built-in `none` cache MUST always be available, which disables task skipping entirely.
- **FR-012**: A task MUST be able to reference a named cache by setting `cache.name` in its task configuration.

### Key Entities

- **Cache**: A named entry in the `caches:` map; contains a `method` (change detection strategy) and a `backend` (storage configuration).
- **Local Backend**: Stores cache entries on the local filesystem; configurable via a `path` field.
- **S3 Backend**: Stores cache entries in an S3-compatible bucket; configurable via `bucket`, `region`, `endpoint`, `prefix`, and `forcePathStyle`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An unchanged task is skipped on the second invocation when using the default local cache with `checksum` method.
- **SC-002**: A task result pushed from one machine is pulled and skips execution on a second machine using the same S3-backed cache configuration.
- **SC-003**: A build completes successfully even when the configured S3 backend is unreachable, with a warning visible in the output.
- **SC-004**: Declaring `caches.default` with an S3 backend causes all tasks (that do not explicitly reference a different cache) to push their results to that S3 bucket.
- **SC-005**: A task using `method: none` executes on every invocation regardless of whether source files have changed.

## Assumptions

- The `cache.name` field on a task (referencing a named cache) is the task-level hook into this feature; full task-level caching options are covered by the task/caching spec page.
- The `--cache` CLI flag controls the method for tasks using the implicit default cache; it does not affect tasks that explicitly reference a named cache by name.
- "Pulling" a cached result means restoring the task's `generates:` outputs so downstream tasks can use them without re-running the producing task.
- The `checksum` method hashes file content; `modify-date` compares filesystem mtime; both apply to the files listed in the task's `src:` field.
