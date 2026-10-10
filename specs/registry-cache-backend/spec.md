# Feature Specification: OCI Registry Cache Backend

**Feature Branch**: `005-registry-cache-backend`

**Created**: 2026-05-31

**Status**: Implemented (1.7.0)

**Input**: 1.7 brainstorm — a third cache backend that stores cache entries in a container registry, alongside the existing `local` and `s3` backends. Everyone already has a registry; this removes the need to provision an S3 bucket for shared caching.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Share cache through a registry (Priority: P1)

A team declares a cache whose `backend` is a container registry. On CI and on laptops, `push`/`pull` move cached task outputs to and from that registry, so a fresh runner restores outputs another machine produced.

**Why this priority**: Distributed caching is the core differentiator; a registry backend lowers the barrier to using it because the registry already exists in most setups.

**Independent Test**: Configure a `registry` cache against a local `registry:2`, run a task to push, wipe the local cache, run again — the second run restores from the registry (cache hit) without re-executing.

**Acceptance Scenarios**:

1. **Given** a task with a `registry`-backed cache and a populated registry entry for its current state key, **When** the task runs on a machine with an empty local cache, **Then** the outputs are pulled from the registry and the task is skipped.
2. **Given** a successful task run with a `registry`-backed cache, **When** the run completes, **Then** an artifact keyed by the task id and state key exists in the registry.
3. **Given** a state key with no registry entry, **When** `has()` is queried, **Then** it reports a miss and the task executes normally.

### User Story 2 - Reuse existing registry credentials (Priority: P1)

The backend authenticates the same way image pulls and `hammerkit package <registry>` already do, so no new credential mechanism is introduced.

**Why this priority**: A separate auth path would violate "one config, many tools" and add friction.

**Independent Test**: With docker login already done for a private registry, a `registry`-backed cache push/pull succeeds without extra hammerkit credential config.

**Acceptance Scenarios**:

1. **Given** valid registry credentials available to the existing image-pull/push path, **When** the registry cache backend pushes or pulls, **Then** it authenticates without additional hammerkit-specific credential config.

### Edge Cases

- Registry unreachable on `pull`/`has` → treated as a cache miss with a clear warning; the build proceeds (a missing cache must never fail a build).
- Registry unreachable or unauthorized on `push` → a **warning, not fatal**; the build continues, matching the existing backends (a failed push is logged as `warn` in `execute-work-task.ts` — caching is an optimization, so a push failure never fails the build).
- Task id + state key that would exceed registry tag-length/charset limits → reference is derived via a hash rather than failing.
- Re-push of an already-present entry → idempotent (no-op or identical overwrite), never a partial artifact.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a `registry` cache backend implementing the existing `CacheBackend` interface (`has`, `pull`, `push`, `clear`) against an OCI registry.
- **FR-002**: Each cache entry (taskId + stateKey) MUST map to a deterministic, addressable registry reference so that `has()` is a metadata lookup, not a full download.
- **FR-003**: The backend MUST authenticate using the same credential resolution as hammerkit's existing image pull / `package` push path — no new credential surface.
- **FR-004**: `push` MUST be atomic and idempotent: a partially uploaded entry MUST NOT be visible to `has()`/`pull()` (mirroring the local backend's "stats written last" guarantee).
- **FR-005**: The backend MUST register with the cache-backend factory/registry the same way `local` and `s3` do, selectable via the `caches:` block `backend` field.
- **FR-006**: The backend MUST NOT require any external binary beyond the registry/Docker client hammerkit already depends on (no `oras`/`skopeo`).
- **FR-007**: A registry that is unreachable on read MUST degrade to a cache miss, never abort the build.
- **FR-008**: The `caches:` schema addition MUST be additive and non-breaking (Stable Contracts).

### Key Entities

- **Registry cache backend spec**: registry reference, optional repository/namespace, optional tag prefix.
- **Cache artifact**: the packaged task outputs (a tar) plus a manifest, stored in the registry under the entry's derived reference.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a task runs with a `registry` cache, a corresponding artifact is retrievable from the registry by its derived reference.
- **SC-002**: On a machine with an empty local cache but a populated registry, the task is a cache hit and executes no commands.
- **SC-003**: A `has()` query performs a metadata lookup without downloading the full artifact.
- **SC-004**: An unreachable registry on pull yields a miss and a warning, and the build still completes.

## Assumptions

- Cache entries are stored as a standard OCI **image manifest with a single tar layer** (maximizing registry compatibility) rather than a custom artifact media type (resolved — ADR-0005).
- The integration test exercises a real `registry:2` per the "real integrations over mocks" heuristic (the existing `ensureLocalRegistry()` harness already provisions one).
- Garbage collection of registry cache entries is handled by [cache-retention](../cache-retention/spec.md) and/or the registry's own retention, not by this backend in isolation.
