# Feature Specification: Matrix (Parametrized) Tasks

**Feature Branch**: `008-matrix-tasks`

**Created**: 2026-05-31

**Status**: Draft

**Input**: 1.7 brainstorm — define a task once with a `matrix` of variants (e.g. node versions, architectures); hammerkit expands it into one independently-cacheable work item per combination. This is a schema-contract change and the item needing the most design care (Stable Contracts).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run one task across variants (Priority: P1)

A developer declares a single task with a `matrix` axis (e.g. `node: [20, 22, 24]`) and references the value in the task's `image`/`cmds`/`env`. Hammerkit expands it into one instance per value, each running independently.

**Why this priority**: Eliminates copy-pasted near-duplicate tasks — directly serves "one config, many tools".

**Independent Test**: A task with `matrix: { node: [20, 22] }` and `image: node:${matrix.node}` expands to two runs, one per node image.

**Acceptance Scenarios**:

1. **Given** a task with a single-axis `matrix`, **When** the task is run, **Then** one instance executes per matrix value.
2. **Given** a matrix value referenced in `image`, **When** an instance runs, **Then** it uses the image with that value substituted.
3. **Given** a matrix value referenced in `cmds`/`env`, **When** an instance runs, **Then** the substituted value is present in the command/environment.

### User Story 2 - Cross-product of multiple axes (Priority: P2)

A developer declares two matrix axes (e.g. `node` and `arch`); hammerkit runs the cross-product.

**Why this priority**: Common for compatibility matrices; builds on the single-axis mechanics.

**Independent Test**: `matrix: { node: [20, 22], arch: [amd64, arm64] }` expands to four instances.

**Acceptance Scenarios**:

1. **Given** a two-axis matrix, **When** the task runs, **Then** one instance executes per combination of values.

### User Story 3 - Address and cache instances independently (Priority: P2)

Each expanded instance has a deterministic, stable name (e.g. `test:node=24`), can be run or filtered individually, and is cached independently — its matrix values participate in its state key.

**Why this priority**: Independent caching is what makes a matrix worthwhile incrementally; without it a change to one variant would invalidate all.

**Independent Test**: Run the matrix, change one input affecting only the `node=24` instance, re-run — only `node=24` rebuilds; the others stay cached.

**Acceptance Scenarios**:

1. **Given** a matrix task, **When** the user runs a specific instance by name, **Then** only that instance executes.
2. **Given** a matrix task that ran once, **When** an input affecting one instance changes, **Then** only that instance is a cache miss.

### Edge Cases

- An empty axis (`node: []`) → zero instances; reported clearly, not a silent no-op or a crash.
- A single-value axis → exactly one instance (degenerate but valid).
- An instance name colliding with an explicitly-declared task id → rejected with a clear validation error.
- An interpolation reference to a non-existent matrix key → validation error naming the bad reference.
- `deps`/`needs` referencing a matrix task → [NEEDS CLARIFICATION: does a dependency on a matrix task mean "all instances" or must it target a specific instance? Default: depending on the matrix task depends on all instances.]

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A task MUST accept an optional `matrix` map of axis name → list of values; the task expands into one instance per element of the cross-product across all axes.
- **FR-002**: Matrix values MUST reach task fields (`image`, `cmds`, `env`). [DEFERRED — needs design. Constraint discovered: hammerkit's existing interpolation is deliberately minimal — only whole-value `$NAME`, only in `envs`, **no `${...}` braces and no partial/inline substitution** ([environment-variables.md](../../docs/build-file/environment-variables.md)). So an inline `image: node:${matrix.node}` would be a *new* interpolation dialect on a contract surface. Leading candidate is an **overlay model** (matrix = named variants overlaying whole task fields, reusing `extend`/`includes` merge semantics, no templating) rather than axes+interpolation. Not decided.]
- **FR-003**: Each expanded instance MUST be independently cacheable, with its matrix values contributing to its state key.
- **FR-004**: Each instance MUST have a deterministic, stable identifier derived from its axis values, addressable for run and label filtering.
- **FR-005**: Matrix tasks MUST integrate with `deps`, `needs`, labels, and parallel scheduling.
- **FR-006**: An invalid interpolation reference or a name collision MUST be reported at validation time.
- **FR-007**: Tasks without a `matrix` MUST be unaffected; the schema addition MUST be additive and non-breaking (Stable Contracts).

### Key Entities

- **Matrix axis**: a name and an ordered list of values.
- **Matrix instance**: a concrete assignment of one value per axis.
- **Expanded task**: the work item produced for a matrix instance, with values substituted and a derived id.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task with axes of sizes m and n expands to exactly m×n instances.
- **SC-002**: Changing an input that affects only one instance produces exactly one cache miss; the others remain hits.
- **SC-003**: Instance identifiers are stable across runs of the same build file.
- **SC-004**: A build file with no `matrix` produces identical behavior to the prior version.

## Assumptions

- Matrix expansion happens in the parser/planner before scheduling, so the rest of the runtime sees ordinary work items.
- Scope is **tasks first**; matrix on services is out of scope for v1 unless a concrete need emerges (YAGNI / "add nothing speculative").
- The existing env substitution is whole-value `$NAME` only (no braces/partial), so reusing it verbatim cannot parametrize `image`/`cmds` inline; an overlay-of-variants model is the likely direction (deferred — see FR-002).
