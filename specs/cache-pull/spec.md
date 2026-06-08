# Feature Specification: Cache Pull / Push (split network from compute)

**Feature Branch**: `012-cache-pull`

**Created**: 2026-05-31

**Status**: Draft

**Input**: 1.7 brainstorm — a standalone `cache pull` command (and its sibling `cache push`) that moves cache artifacts between the configured backend and the local environment **without executing any task**, so a CI pipeline can separate the network-bound phase from the compute-bound phase across jobs or runners.

## Motivation

Today cache restore happens inline during a run: the scheduler calls `backend.pull(...)` per task as it enqueues work ([enqueue-next.ts:108](../../src/executer/scheduler/enqueue-next.ts)), interleaving network I/O with compute. For large remote caches this couples two very different kinds of work. Splitting them lets a pipeline do:

```
job: prefetch  →  hammerkit cache pull   (network-bound, no compute)
job: build     →  hammerkit run          (compute-bound, cache already warm)
job: upload    →  hammerkit cache push   (network-bound, no compute)
```

This rounds out the `cache` command group alongside `cache ls` / `cache prune` from [cache-retention](../cache-retention/spec.md): `cache pull | push | ls | prune`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prefetch the cache before building (Priority: P1)

A developer (or CI job) runs `hammerkit cache pull` to fetch the cache entries the upcoming build will need from the remote backend into the local environment, executing no task. The subsequent build is then compute-bound, reading an already-warm cache.

**Why this priority**: This is the core value — moving network work out of the build's critical path.

**Independent Test**: With a populated remote backend and an empty local cache, run `cache pull`, then run the build offline (or with network blocked) — the build's cached tasks resolve without further network access.

**Acceptance Scenarios**:

1. **Given** a remote backend holding entries for the in-scope tasks' current state keys, **When** `hammerkit cache pull` runs, **Then** those entries are fetched locally and no task command executes.
2. **Given** a warmed local cache from a prior `cache pull`, **When** the build runs, **Then** it performs no additional network pulls for the entries already present.
3. **Given** a state key with no matching remote entry, **When** `cache pull` runs, **Then** that entry is skipped (best-effort) and the command still succeeds.

### User Story 2 - Offload cache upload after building (Priority: P1)

After a build, a separate `hammerkit cache push` job uploads the locally-produced cache entries to the remote backend, so the build job itself does not block on upload.

**Why this priority**: The symmetric half — moving upload network work off the build job.

**Independent Test**: Run a build that produces cache entries locally, then `cache push`, and verify the remote backend now holds those entries.

**Acceptance Scenarios**:

1. **Given** locally-produced cache entries for the in-scope state keys, **When** `hammerkit cache push` runs, **Then** those entries are uploaded to the configured backend and no task executes.
2. **Given** entries already present remotely, **When** `cache push` runs, **Then** it is a no-op for those entries (idempotent).

### User Story 3 - Scope the pull/push (Priority: P2)

A developer limits the pull/push to a task subset or by labels, and includes transitive dependencies' state keys.

**Why this priority**: Large monorepos want to warm only the relevant slice.

**Independent Test**: `cache pull --filter <label>` fetches only entries for matching tasks (and their deps).

**Acceptance Scenarios**:

1. **Given** a label filter, **When** `cache pull`/`cache push` runs, **Then** only entries for matching tasks and their transitive deps are moved.

### Edge Cases

- Remote backend unreachable → a clear, surfaced error (unlike inline auto-pull, which degrades to a miss; an *explicit* pull/push should report transport failure).
- An individual entry absent remotely on pull → skipped, not an error (best-effort hydration).
- Local entry absent on push → skipped with a note (nothing to upload for that key).
- Interrupted transfer → per-entry atomicity (a partial entry MUST NOT be visible as complete), mirroring the backends' "stats written last" guarantee.
- Re-running pull/push when everything is already present → no-op.
- Concurrent pull and run → MUST NOT corrupt an entry mid-transfer.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide `hammerkit cache pull [task]` that, for the in-scope tasks, computes their current state keys and fetches matching entries from the configured backend into the local environment, executing no task command and starting no container/service.
- **FR-002**: The system MUST provide `hammerkit cache push [task]` that uploads local cache entries for the in-scope state keys to the configured backend, executing no task command.
- **FR-003**: Both commands MUST honor label scope (`--filter` / `--exclude`) and MUST include transitive dependencies' state keys.
- **FR-004**: On pull, a remotely-absent entry MUST be skipped (best-effort); a backend/transport failure MUST be reported clearly and fail the command.
- **FR-005**: Both commands MUST be idempotent — moving an already-present entry is a no-op.
- **FR-006**: Transfers MUST be per-entry atomic; an interrupted transfer MUST NOT leave a partial entry visible as complete.
- **FR-007**: `cache pull` followed by a build MUST produce the same result as the build alone — pull only pre-warms; it never changes correctness or cache decisions.
- **FR-008**: State-key computation MUST reuse the existing engine (shared with [cache-explain](../cache-explain/spec.md) / `--dry-run`), not a parallel implementation.
- **FR-009**: Output MUST route through the `Environment` (no `console.*`).

### Key Entities

- **Cache entry**: a (taskId, stateKey) artifact in the configured backend.
- **Scope**: the set of in-scope tasks (plus transitive deps) whose current state keys determine which entries to move.
- **Local environment / remote backend**: the two ends a pull/push moves entries between.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `cache pull`, every in-scope entry present on the remote backend exists locally.
- **SC-002**: A build run immediately after `cache pull` performs zero network pulls for entries already warmed.
- **SC-003**: After `cache push`, every locally-produced in-scope entry exists on the remote backend.
- **SC-004**: `cache pull` and `cache push` execute zero task commands and start zero containers.
- **SC-005**: Splitting a pipeline into pull → build → push yields the same final outputs as a single combined run.

## Assumptions

- The entries to move are determined by the **current** state keys (what the present commit would use), not the entire cache history — warming what the build needs, not everything.
- **Resolved (ADR-0001)**: no read-through tier. Tasks cache against the **local** backend; `cache pull --remote <name>` / `cache push --remote <name>` are the only operations that touch a **remote backend** (S3, registry). Pull syncs remote→local for the in-scope state keys; the build never performs remote I/O. The remote is a normal entry in `caches:` selected by the `--remote` flag.
- This composes with, and does not replace, the existing inline auto-pull during a run; pull/push are an optional optimization for pipelines that want the network/compute split.
- The commands belong to the same `cache` command group as `cache ls` / `cache prune` ([cache-retention](../cache-retention/spec.md)).
