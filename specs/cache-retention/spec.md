# Feature Specification: Cache Retention & Cleanup

**Feature Branch**: `006-cache-retention`

**Created**: 2026-05-31

**Status**: Implemented (1.7.0)

**Input**: 1.7 brainstorm — evict old cache entries by age, last-used (LRU), and/or total storage size. The `checksum`-by-default change plus remote backends make caches grow unbounded; this is the operational counterweight. Distinct from the existing `clean` command, which wipes a project's cache+outputs rather than garbage-collecting by policy.

## Distinction from `clean`

`hammerkit clean` removes a project's generated outputs and (with `--cache`) its cached results outright. This feature adds **policy-based garbage collection** over the cache store: keep recent/needed entries, evict old or excess ones. Correctness is preserved because evicting any entry only ever causes a rebuild — never a false hit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prune the cache by policy on demand (Priority: P1)

A developer runs `hammerkit cache prune` and hammerkit removes cache entries that exceed the configured (or flag-overridden) retention: older than a max age, beyond a total size cap, or older than the most-recent N versions per task.

**Why this priority**: The unbounded-growth problem is concrete and immediate, especially with checksum-default and remote backends.

**Independent Test**: Populate a local cache with several task versions, set `--keep 1`, run `hammerkit cache prune`, and verify only the newest version per task remains.

**Acceptance Scenarios**:

1. **Given** multiple cached state-key versions for a task and `keepPerTask: 1`, **When** `hammerkit cache prune` runs, **Then** only the most recent version per task remains.
2. **Given** a `maxSize` smaller than the current cache, **When** prune runs, **Then** entries are evicted oldest/least-recently-used first until the total is under the cap.
3. **Given** a `maxAge` of 30 days, **When** prune runs, **Then** entries not used within 30 days are evicted.

### User Story 2 - Configure automatic retention (Priority: P1)

A team declares a `retention` policy in the `caches:` block so cache size is bounded without anyone remembering to prune.

**Why this priority**: Policy-as-config is the "one config, many tools" way to keep CI caches bounded.

**Independent Test**: Declare `retention: { maxSize: 1Gi }`, run enough builds to exceed it with opportunistic prune enabled, and verify the cache stays under the cap.

**Acceptance Scenarios**:

1. **Given** a `retention` policy on a cache, **When** a configured automatic prune trigger fires, **Then** the policy is applied without an explicit `cache prune` invocation.

### User Story 3 - Inspect cache usage (Priority: P2)

A developer runs `hammerkit cache ls` (or `stats`) to see entries, their sizes, and last-used times before deciding what to prune.

**Why this priority**: Visibility supports the prune workflow but is not strictly required to bound size.

**Independent Test**: `hammerkit cache ls` lists each entry with task id, state key, size, and last-used timestamp.

**Acceptance Scenarios**:

1. **Given** a populated cache, **When** the user runs `hammerkit cache ls`, **Then** each entry's task id, state key, size, and last-accessed time are listed.

### Edge Cases

- An entry matching a task's *current* state key may still be evicted by policy (e.g. it is old) — acceptable, because it only causes a rebuild, never a false hit.
- Filesystem `atime` is unreliable (relatime/noatime) → last-used MUST come from a hammerkit-owned marker updated on pull, not from OS atime.
- Remote/shared backends (s3, registry): age and size eviction work from object metadata; true global LRU needs the access marker written back to the shared store and MAY be opt-in due to per-hit write cost.
- A backend that cannot report entry sizes → size-based eviction is unavailable for it and reports so, rather than silently doing nothing.
- Concurrent prune and run → prune MUST NOT delete an entry currently being pulled/pushed.
- S3 lifecycle rules already configured on the bucket → documented as a coexisting alternative; hammerkit prune and bucket lifecycle are not mutually exclusive.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `CacheBackend` interface MUST gain introspection: list entries with taskId, stateKey, size, createdAt, and lastAccessedAt (where the backend can supply them).
- **FR-002**: The system MUST support eviction by maximum age, by total size cap (evict oldest/LRU until under cap), and by per-task version count (`keepPerTask`).
- **FR-003**: The system MUST update a hammerkit-owned last-accessed marker on each cache hit (`pull`); it MUST NOT rely on filesystem atime.
- **FR-004**: The system MUST provide a `hammerkit cache prune` command applying the configured retention, with CLI overrides `--max-age`, `--max-size`, and `--keep`. Prune defaults to the **local** cache; pruning a **remote** backend MUST require an explicit `--remote <name>` (mirroring `cache pull`/`push`), so no remote delete is ever implicit (ADR-0001). Remote pruning supports age / size / `keepPerTask` from object metadata; global LRU on a remote stays out until the write-back access marker exists.
- **FR-005**: The `caches:` schema MUST accept an optional `retention` block (`maxAge`, `maxSize`, `keepPerTask`); the addition MUST be additive and non-breaking.
- **FR-006**: Durations and sizes MUST use a documented format (e.g. `30d`, `5Gi`); invalid values MUST be rejected with a clear error.
- **FR-007**: Eviction MUST never produce a false cache hit — a pruned entry simply causes a rebuild.
- **FR-008**: `cache prune` MUST be distinct in behavior and documentation from `clean`.
- **FR-009**: For backends unable to provide size or last-used data, the unsupported policy MUST be reported as unavailable rather than silently ignored.
- **FR-010**: Output MUST route through the `Environment` (no `console.*`).

### Key Entities

- **Retention policy**: `maxAge`, `maxSize`, `keepPerTask` — any subset, combined (size is a hard ceiling; age is a floor).
- **Cache entry metadata**: taskId, stateKey, size, createdAt, lastAccessedAt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `cache prune --keep 1`, exactly one (newest) version per task remains.
- **SC-002**: After a size-capped prune, the total cache size is at or below the cap.
- **SC-003**: An entry pulled (cache hit) updates its last-accessed marker, and an age-based prune spares recently-used entries.
- **SC-004**: No prune operation ever causes a subsequent run to serve stale output as a hit.

## Assumptions

- The local backend stores entries as `<root>/<taskId>/<stateKey>/` directories (with `stats.json` written last); entry enumeration and size come from walking this layout, and the last-used marker is a small sidecar in each entry directory.
- Automatic prune (resolved): explicit `cache prune` by default; an **opt-in** auto-prune of the **local** cache runs after a successful build only when a `retention` policy is declared. The remote is **never** auto-pruned — no implicit network deletes (ADR-0001).
- Global LRU for shared backends is opt-in; age and size eviction are the default cross-backend policies.
