# Feature Specification: Build Summary

**Feature Branch**: `003-build-summary`

**Created**: 2026-05-31

**Status**: Draft

**Input**: 1.7 brainstorm — print an end-of-run summary (per-task status + duration, aggregate cache-hit ratio) fed by the existing event stream and the cache-explain engine.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what happened at the end of a run (Priority: P1)

After a `hammerkit run`, the developer sees a compact table: each task with its result (executed, cached, failed, cancelled) and wall-clock duration.

**Why this priority**: The single most-requested visibility improvement; it makes cache behavior and slow steps obvious at a glance.

**Independent Test**: Run a graph with one cached and one executed task; the summary lists both with correct status and the cached one at ~0s.

**Acceptance Scenarios**:

1. **Given** a completed run with a mix of cached and executed tasks, **When** the run finishes, **Then** a summary lists each task with its status and duration.
2. **Given** a cached task, **When** the summary prints, **Then** that task shows as cached with a near-zero duration and no command output attributed to it.
3. **Given** a failed task, **When** the summary prints, **Then** the failed task is clearly distinguished from successful ones.

### User Story 2 - See aggregate cache effectiveness (Priority: P2)

The developer sees totals: how many tasks executed vs were cached, the cache-hit ratio, and total wall-clock time.

**Why this priority**: Quantifies the payoff of caching — directly serves the "caching reduces waste" value.

**Independent Test**: Run a graph of 4 tasks where 3 are cached; the summary reports 1 executed / 3 cached and a 75% hit rate.

**Acceptance Scenarios**:

1. **Given** a finished run, **When** the summary prints, **Then** it includes counts of executed vs cached tasks and the cache-hit ratio.

### User Story 3 - Machine-readable summary (Priority: P3)

A CI job consumes the summary as JSON to publish build metrics.

**Why this priority**: Valuable for dashboards but secondary to the human view.

**Independent Test**: `hammerkit run --json` (or `--summary=json`) emits a valid JSON summary object.

**Acceptance Scenarios**:

1. **Given** any run, **When** JSON summary output is requested, **Then** valid JSON with per-task and aggregate fields is emitted.

### Edge Cases

- Empty graph (no tasks in scope) → a summary that says nothing ran, not a crash.
- Cancelled run → tasks that did not start show as cancelled/skipped; the summary reflects partial completion.
- A task that both pulled cache and exported outputs → counted as cached, not executed.
- Very large graphs → output stays readable (deterministic order, no unbounded width).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST print a per-task summary at the end of a run showing status (executed, cached, failed, cancelled) and wall-clock duration.
- **FR-002**: The system MUST print aggregate metrics: number executed vs cached, cache-hit ratio, and total duration.
- **FR-003**: Task status MUST derive from the existing execution event stream and the cache-decision result, not from re-running anything.
- **FR-004**: Summary output MUST be deterministically ordered (stable across runs of the same graph).
- **FR-005**: The system MUST allow suppressing the summary (`--no-summary`) and MUST allow JSON output.
- **FR-006**: Output MUST route through the `Environment` (no `console.*`).
- **FR-007**: The summary MUST NOT change exit codes or execution behavior — it is reporting only.

### Key Entities

- **Task result**: taskId, status, duration, (optional) cache-miss cause from [cache-explain](../cache-explain/spec.md).
- **Run summary**: the collection of task results plus aggregates (counts, hit ratio, total time).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After any run, every task in scope appears exactly once in the summary with a status.
- **SC-002**: A cached task is reported as cached with a duration under a small threshold (≈0s).
- **SC-003**: The reported executed/cached counts match the actual scheduler decisions for the run.
- **SC-004**: `--no-summary` produces no summary output and changes nothing else.

## Assumptions

- Per-task timing and status are already observable on the execution event stream (`state.ts` / work-item status); this feature aggregates and renders them.
- Reusing the cache-explain cause (optional) enriches the summary but is not required for the P1 table.
- Default behavior is to print the human summary; JSON and suppression are opt-in flags, keeping the default CLI contract additive.
