# Feature Specification: Service State Snapshots (cacheable side effects)

**Feature Branch**: `011-service-state-snapshot`

**Created**: 2026-05-31

**Status**: Draft (design spike — model not yet settled)

**Input**: 1.7 brainstorm — a task with a `needs` service produces data *inside the service* (e.g. a seed script populating a Postgres DB). That state is expensive to recreate and would be valuable to cache, especially in CI. Today hammerkit only caches declared **files** (`src` → `generates`); a service's internal state is neither. This spec proposes treating a service's post-producer state as a cacheable artifact, captured and restored by a defined mechanism and keyed by the producing task's inputs.

## Problem framing

Caching today keys on a task's `src` and stores its `generates` (files on disk). A seeded database lives inside the service container's volume, invisible to that model. To cache it, hammerkit must:

1. Treat a service's post-producer **state as a cacheable artifact**.
2. **Key** that artifact on the inputs that produced it (the seed/migration sources + the service base image).
3. **Capture** the state into an artifact and **restore** it into a fresh service on a cache hit — replacing the re-run of the producer.

The reframing that makes this tractable: a service snapshot is *"a `generates` for a service"* — an output materialized by a command rather than sitting on disk. The artifact is files, so it can reuse the existing cache backends, `store`/`restore`, and retention.

## Capture mechanisms (two modes)

- **`export` mode (recommended default)** — user-supplied commands serialize the service state to a file and load it back (`pg_dump`/`pg_restore`, `mysqldump`, `mongodump`, etc.). DB-agnostic, portable across machines and architectures, and the artifact is a plain file that rides the existing file-cache path. Requires the dump tool to be available to the service.
- **`volume` mode (alternative)** — hammerkit captures the service's data volume/dir as a tarball (Docker) or a PVC snapshot (Kubernetes; the persistent-data upload/download path in `ensure-persistent-data.ts`/`volumes.ts` is precedent). No user commands, but the artifact is coupled to the exact image version/architecture and the service must be quiesced for a consistent copy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cache a seeded database to skip re-seeding (Priority: P1)

A developer has a `seed` task that needs a `db` service and populates it. With a snapshot declared, the first run seeds and captures the DB state; subsequent runs with unchanged seed inputs start a fresh `db`, restore the snapshot, and skip the seed entirely.

**Why this priority**: This is the whole point — turning an expensive, repeated side effect into a cache hit, especially in CI.

**Independent Test**: Run `seed` once (captures snapshot), run again with no changes — `db` is restored from the snapshot, `seed` is reported as cached, and a downstream task reading `db` sees the seeded data.

**Acceptance Scenarios**:

1. **Given** a producer task with unchanged inputs and a stored snapshot, **When** the build runs, **Then** the service is started fresh, the snapshot is restored, and the producer task does not execute.
2. **Given** a producer task whose inputs changed, **When** the build runs, **Then** the snapshot is treated as a miss, the producer re-runs, and a new snapshot is captured.
3. **Given** a restored snapshot, **When** a downstream task that `needs` the service runs, **Then** it observes the produced state.

### User Story 2 - Portable snapshot shared across CI machines (Priority: P1)

The snapshot artifact is stored in a shared cache backend (local/s3/registry) so a fresh CI runner restores a seeded DB another machine produced, instead of re-seeding.

**Why this priority**: The stated motivation is CI speed-up via distributed reuse.

**Independent Test**: Capture a snapshot on machine A into a shared backend; on machine B with an empty local cache, the producer is a cache hit and the snapshot restores.

**Acceptance Scenarios**:

1. **Given** a snapshot stored in a shared backend, **When** a different machine runs the producer with matching inputs, **Then** it restores the snapshot rather than executing the producer.

### User Story 3 - Choose the capture mechanism (Priority: P2)

A developer selects `export` mode (dump/restore commands) for portability, or `volume` mode (data-dir/PVC snapshot) for zero-command DB-agnostic capture, per their needs.

**Why this priority**: Different databases and constraints call for different mechanisms; one size will not fit all.

**Independent Test**: A service configured with `export` commands produces a portable file artifact; a service configured with `volume` mode produces a volume tarball.

**Acceptance Scenarios**:

1. **Given** `mode: export` with export/import commands, **When** a snapshot is captured, **Then** the artifact is the file the export command produced.
2. **Given** `mode: volume`, **When** a snapshot is captured, **Then** the artifact is the service's data volume contents.

### Edge Cases

- **Base image change** (e.g. `postgres:16` → `:17`): the service image MUST participate in the state key. In `volume` mode a cross-version restore is unsafe and MUST be refused (a false restore is a defect, not a speed trade).
- **Multiple producers** (migrate → seed): the snapshot's state key MUST fold *all* producer inputs in a defined order. [NEEDS CLARIFICATION: how the producer set and its order are declared.]
- **Consistency**: `export` mode relies on the command producing a consistent (transactional) dump; `volume` mode MUST quiesce/flush the service before capture. [NEEDS CLARIFICATION: quiesce strategy for volume mode.]
- **Readiness ordering**: a restored service is not "ready" for dependents until import completes — a post-start import phase distinct from the healthcheck.
- **Shared / `continuous` services** (1.6.0): snapshotting a long-lived service shared by many needers is out of scope for v1; scope to a service whose state is produced within the run.
- **Missing dump tool** (export mode): a clear error, not a confusing in-container failure.
- **Empty/failed producer**: a failed producer MUST NOT capture or overwrite a snapshot.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A service MUST be able to declare a `snapshot` capability with a `mode` (`export` or `volume`), an artifact `path`/target, and — for `export` — `export` and `import` commands.
- **FR-002**: A producer relationship MUST be declarable so hammerkit knows which task(s) produce the service's cached state and which inputs (`src`) key it. [NEEDS CLARIFICATION: declared on the service (`producedBy`) or on the task (`snapshots: [svc]`)?]
- **FR-003**: The snapshot state key MUST be derived from the producer task(s)' inputs, the service base image identity, and the capture command text, such that any change invalidates the snapshot.
- **FR-004**: On a cache hit, the system MUST start the service fresh, restore the snapshot, and skip producer execution; downstream `needs` MUST observe the restored state.
- **FR-005**: On a cache miss, the system MUST run the producer, then capture the snapshot, and store the artifact under the state key in the configured cache backend.
- **FR-006**: The snapshot artifact MUST be storable in the existing cache backends (local/s3/registry) so it is shareable across machines and CI.
- **FR-007**: In `volume` mode, the system MUST encode the service image identity in the key and MUST refuse a restore when it does not match (no cross-version restore).
- **FR-008**: A failed producer MUST NOT capture or overwrite an existing snapshot.
- **FR-009**: Restore MUST complete before any dependent task connects to the service (a defined post-start phase).
- **FR-010**: The feature MUST be opt-in and additive; services and tasks without a `snapshot`/producer declaration behave exactly as today (Stable Contracts).
- **FR-011**: Errors (missing tool, inconsistent dump, image mismatch, capture failure) MUST be reported clearly, naming the service and cause.

### Key Entities

- **Snapshot capability**: on a service — `mode`, artifact `path`, and (export mode) `export`/`import` commands.
- **Producer set**: the ordered task(s) whose execution produces the service state, and whose `src` keys the snapshot.
- **Snapshot artifact**: the captured state (a dump file or volume tarball) stored under the state key in a cache backend.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With unchanged producer inputs, a second run restores the service state and executes the producer zero times.
- **SC-002**: A change to a seed/migration input invalidates the snapshot and triggers exactly one re-capture.
- **SC-003**: A snapshot captured on one machine restores on another via a shared backend without re-running the producer.
- **SC-004**: In `volume` mode, a base-image version change never restores a stale snapshot (it re-captures or refuses).
- **SC-005**: A build with no snapshot declarations behaves identically to the prior version.

## Assumptions

- v1 targets the **`export` mechanism** and the **Docker runtime** first; `volume` mode and the Kubernetes path (which only runs on the self-hosted integration runner per FOLLOWUPS) follow once the model is settled.
- Best-fit producers are explicit, run-time tasks (seed/migrate), not arbitrary external mutation of the service.
- The snapshot artifact reuses the file-cache path, so [cache-retention](../cache-retention/spec.md) and the cache backends apply without new storage code.
- This feature extends the service model from **ephemeral** to **cacheable-stateful** — a deliberate conceptual change that warrants a design spike before implementation. Several core questions (producer-set declaration, key composition, volume-mode quiescence) are marked `[NEEDS CLARIFICATION]` and MUST be resolved before this leaves Draft.
