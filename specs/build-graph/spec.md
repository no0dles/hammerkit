# Feature Specification: Build Graph & Dry-Run

**Feature Branch**: `004-build-graph`

**Created**: 2026-05-31

**Status**: Implemented (1.7.0)

**Input**: 1.7 brainstorm — `hammerkit graph` serializes the task/service dependency graph; `--dry-run` reports the execution plan (with predicted cache hits) without executing. Both reuse the planner's already-built work graph and the [cache-explain](../cache-explain/spec.md) engine.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Visualize the build graph (Priority: P1)

A developer runs `hammerkit graph` and gets the dependency graph — tasks, services, `deps` and `needs` edges — in a renderable format (mermaid by default, graphviz dot optional) they can paste into docs or a viewer.

**Why this priority**: Understanding a build's shape is a frequent need and the planner already holds the graph; serialization is cheap, high-visibility value.

**Independent Test**: Define two tasks where B depends on A; `hammerkit graph` emits a graph with an A→B edge.

**Acceptance Scenarios**:

1. **Given** tasks with `deps`, **When** the user runs `hammerkit graph`, **Then** the output contains a node per task and an edge per dependency.
2. **Given** a task with a service `need`, **When** the user runs `hammerkit graph`, **Then** the service appears as a node and the need is rendered as a distinct edge type from a `deps` edge.
3. **Given** `--format dot`, **When** the user runs `hammerkit graph`, **Then** the output is valid graphviz dot.

### User Story 2 - Preview the execution plan without running (Priority: P1)

A developer runs `hammerkit run <task> --dry-run` and sees the ordered list of what *would* run, which steps would be cache hits, and which would execute — with nothing actually executed.

**Why this priority**: Safe previewing of an incremental build is a core trust feature and pairs naturally with cache-explain.

**Independent Test**: Cache a task, then `hammerkit run <task> --dry-run` reports it as a hit and starts no container.

**Acceptance Scenarios**:

1. **Given** a build graph, **When** the user runs with `--dry-run`, **Then** the ordered plan is printed and **no command executes, no container/service starts, and no cache push/pull occurs**.
2. **Given** a partially cached graph, **When** `--dry-run` runs, **Then** each task is annotated as predicted hit or miss (reusing the cache-explain engine).

### User Story 3 - Scope and export the graph (Priority: P2)

A developer scopes the graph to one task's subgraph, applies label filters, or writes the output to a file.

**Why this priority**: Convenience for large repos; not required for the core value.

**Independent Test**: `hammerkit graph <task>` on a large repo emits only that task's transitive subgraph.

**Acceptance Scenarios**:

1. **Given** a label filter, **When** the user runs `hammerkit graph --filter <label>`, **Then** only matching tasks/services appear.
2. **Given** a single task argument, **When** the user runs `hammerkit graph <task>`, **Then** only that task and its transitive deps/needs are emitted.

### Edge Cases

- A graph containing a cycle (already detected by `hasMixedCycle`) → `graph` still renders and marks/reports the cycle rather than crashing; `--dry-run` reports the cycle as an error.
- An isolated task with no edges → rendered as a lone node.
- A service-only scope (`up`) → graph renders services and their inter-service `deps`/`needs`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST output the work graph including tasks, services, `deps` edges, and `needs` edges, derived from the planner's existing graph.
- **FR-002**: The system MUST support at least two output formats: mermaid (default) and graphviz dot.
- **FR-003**: The output MUST visually distinguish tasks from services and `deps` edges from `needs` edges.
- **FR-004**: `--dry-run` MUST compute the full execution plan and report ordered tasks with predicted cache hit/miss, and MUST NOT execute any command, start any container or service, or perform any cache push/pull.
- **FR-005**: Both `graph` and `--dry-run` MUST honor label scope (`--filter` / `--exclude`).
- **FR-006**: `graph` MUST support scoping to a single task's transitive subgraph.
- **FR-007**: Output MUST route through the `Environment` (no `console.*`).

### Key Entities

- **Graph node**: a task or a service.
- **Graph edge**: a `deps` (task→task) or `needs` (task→service) relationship.
- **Plan entry**: a task in execution order plus its predicted cache decision.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a graph of N tasks with M dependency edges, `graph` emits exactly N task nodes and M dependency edges.
- **SC-002**: The mermaid and dot outputs both parse in their respective standard renderers.
- **SC-003**: `--dry-run` starts zero containers and produces an ordered plan whose hit/miss predictions match a subsequent real run with no intervening changes.
- **SC-004**: `graph <task>` emits only nodes reachable from `<task>`.

## Assumptions

- The planner already constructs the complete work graph (tasks, services, deps, needs); this feature serializes and previews it rather than recomputing relationships.
- `--dry-run` shares the prediction engine with [cache-explain](../cache-explain/spec.md); divergence between predicted and actual decisions is a defect in the shared engine, not two implementations.
- Mermaid is the default because it renders inline in the gitbook docs and GitHub.
