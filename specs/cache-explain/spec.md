# Feature Specification: Cache Explainability (state-key introspection)

**Feature Branch**: `002-cache-explain`

**Created**: 2026-05-31

**Status**: Draft

**Input**: 1.7 brainstorm — surface *why* a task runs or is skipped. The scheduler already computes a per-task state key and compares it to the stored one to decide hit/miss, but discards the comparison. Keeping it as a diff unlocks `explain`, cache-miss reasons, and the build summary.

## Why this is the keystone

Incremental caching is hammerkit's core value, but today a task that rebuilds gives no clue *which input changed*. This feature makes the existing state-key comparison report its cause. It is read-only over the current cache-decision logic and feeds [build-summary](../build-summary/spec.md) and the `--dry-run` plan in [build-graph](../build-graph/spec.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explain whether a task will run (Priority: P1)

A developer runs `hammerkit explain <task>` and sees, for that task and its dependencies, whether it would be skipped (cache hit) or executed (cache miss) — and for a miss, the cause — **without executing anything**.

**Why this priority**: This is the trust-builder; everything else in the feature is a reuse of the same engine.

**Independent Test**: Run a cached task once, change one source file, then `hammerkit explain <task>` — it must report a miss naming the changed file, and run no commands.

**Acceptance Scenarios**:

1. **Given** a task whose `src` files are all unchanged since the last successful run, **When** the user runs `hammerkit explain <task>`, **Then** the task is reported as a cache hit and no command executes.
2. **Given** a task whose source file changed, **When** the user runs `hammerkit explain <task>`, **Then** the task is reported as a cache miss with cause "source changed" and the changed path is named.
3. **Given** a task that has never been run, **When** the user runs `hammerkit explain <task>`, **Then** the cause is reported as "never cached".

### User Story 2 - See why a task rebuilt during a run (Priority: P1)

A developer expected a task to be cached but it rebuilt. During a normal run (with a verbosity flag), hammerkit prints the miss reason inline so they can diagnose it immediately.

**Why this priority**: Most cache-trust questions arise during an ordinary run, not a separate command.

**Independent Test**: Run a task, change an env var it consumes, run again with the verbosity flag — the miss reason "environment variable X changed" appears.

**Acceptance Scenarios**:

1. **Given** a task that executes due to a cache miss, **When** the run is invoked with the explain/verbose flag, **Then** the miss cause and changed input are printed alongside the task's start.

### User Story 3 - Machine-readable explanation (Priority: P3)

A CI script wants the explanation as JSON to gate or annotate a build.

**Why this priority**: Useful but secondary to the human-facing flow.

**Independent Test**: `hammerkit explain <task> --json` emits valid JSON with one entry per task carrying status and cause.

**Acceptance Scenarios**:

1. **Given** any build graph, **When** `hammerkit explain --json` is run, **Then** the output is valid JSON listing each task's predicted status and (for misses) the cause category and changed identifier.

### Edge Cases

- A task with no `src` is uncacheable and always runs → cause "no src declared".
- A cache entry written by an older hammerkit that lacks the per-component breakdown → degrade gracefully to cause "cache format changed" rather than crashing.
- An upstream dependency changed but the task's own inputs did not → cause "dependency <id> changed" (transitive invalidation already exists via `combineStateKeys`).
- Multiple inputs changed → report all causes, not just the first.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a `hammerkit explain [task]` command that reports, per task in scope, whether it would be a cache hit or miss **without executing any command, starting any container/service, or pushing/pulling cache**.
- **FR-002**: For a cache miss, the system MUST classify the cause as one of: source changed/added/removed, environment variable changed, command changed, image changed, dependency changed, or never cached.
- **FR-003**: Where a cause has a concrete identifier, the system MUST name it (file path, env var name, dependency task id).
- **FR-004**: The system MUST persist a per-task-*name* "last resolved" record (the task id, its description, and its source stats), updated each run, so explain can diff the current task against the last one **even when a definition change produces a new task id**. This is additive metadata and MUST NOT affect the cache hit decision (`id` + `stateKey`).
- **FR-005**: The system MUST offer a verbosity/flag on `run` that prints the miss cause when a task executes due to a cache miss.
- **FR-006**: The system MUST support `--json` output for `explain`.
- **FR-007**: The system MUST NOT alter the existing cache hit/miss *decision*; this feature only reports on it.
- **FR-008**: Output MUST route through the `Environment` (no `console.*`), per the constitution.

### Key Entities

- **State key**: The composite key already computed per task to decide caching.
- **State component**: One contributor to the state key — kind (source/env/cmd/image/dependency), identifier, and hashed value.
- **Cache entry metadata**: The stored breakdown (taskId, stateKey, components) enabling later diffing.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any single changed source file, `explain` names that exact file as the cause.
- **SC-002**: `explain` executes zero task commands and starts zero containers.
- **SC-003**: A first-ever run of a task is explained as "never cached", not as an error.
- **SC-004**: When only an upstream dependency changed, the downstream task's cause is reported as the dependency, not its own sources.

## Assumptions

- Cache identity is **two layers**: the **task id** (sha1 of the description — command, image, env, mounts, shell, `src` paths, `generates`, deps) and the **state key** (hash of `src` file contents folded with dep keys). A definition change moves the id; a source-content change moves the state key. Explain diffs both layers against the persisted last-resolved record (FR-004) rather than re-deriving them.
- Persisting the component breakdown is additive to the existing entry metadata and does not change the state-key value itself (no spurious invalidation on upgrade beyond the one already expected).
- The first run after upgrading to a hammerkit that stores breakdowns will explain pre-existing entries as "cache format changed".
