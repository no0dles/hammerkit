# Feature Specification: CLI: store / restore

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/store-restore.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cache CI artifacts between pipeline runs (Priority: P1)

A developer configures their CI pipeline so that after each successful build, all task-generated outputs and the hammerkit cache are saved to a designated folder. On the next pipeline run, CI restores that folder first, then runs hammerkit. Tasks whose inputs have not changed are skipped because their outputs and cache state are already present, reducing total pipeline time.

**Why this priority**: The primary value of store/restore is CI acceleration by avoiding redundant work across pipeline runs.

**Independent Test**: Create a build file with a task that has `src` and `generates` fields. Run the task, store the cache, delete local outputs, restore the cache, and confirm hammerkit skips the task on the next run.

**Acceptance Scenarios**:

1. **Given** a build file with tasks that declare `generates` outputs, **When** `hammerkit store <dir>` is run after tasks have executed, **Then** all generated files/folders and the hammerkit cache are moved into `<dir>`.

2. **Given** a previously stored cache directory `<dir>`, **When** `hammerkit restore <dir>` is run, **Then** the hammerkit cache and generated outputs are recovered so that unchanged tasks are skipped on the next run.

3. **Given** a CI pipeline that saves and restores the cache directory between runs, **When** source inputs have not changed between runs, **Then** hammerkit skips the affected tasks on the second run.

### User Story 2 - Selective state recovery after cache restoration (Priority: P2)

A developer restores a previously stored cache and then modifies one source file. Only the task whose inputs changed is re-executed; all other tasks with unchanged inputs are still skipped.

**Why this priority**: Demonstrates that store/restore integrates correctly with hammerkit's existing input-change detection rather than replacing it.

**Independent Test**: After restoring a cache, modify one source file and run the dependent task. Confirm only that task executes and others are skipped.

**Acceptance Scenarios**:

1. **Given** a restored cache where some task outputs and cache state are present, **When** a source file for one task is modified and hammerkit is run, **Then** only the task whose source changed is re-executed.

### Edge Cases

- Running `hammerkit restore <dir>` when `<dir>` does not exist or is empty should not silently corrupt the local cache state.
- Running `hammerkit store <dir>` when no tasks have generated any outputs should still complete without error.
- The destination folder for `store` must be provided; omitting it is an error.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept a required destination folder argument for `hammerkit store <dir>` and move all task-generated outputs (declared via `generates`) and the hammerkit cache into that folder.
- **FR-002**: System MUST accept a required source folder argument for `hammerkit restore <dir>` and recover the hammerkit cache and generated outputs from that folder into their expected locations.
- **FR-003**: After a successful restore, hammerkit MUST recognize restored task outputs as valid cached results so that tasks with unchanged inputs are skipped on the next run.
- **FR-004**: The store and restore commands MUST be designed for use in CI environments where the destination folder is managed by the CI caching mechanism.

### Key Entities

- **Cache directory**: A folder supplied by the user that holds the exported hammerkit cache state and all generated task outputs; it is the unit transferred between CI pipeline runs.
- **Generated output**: A file or directory declared in a task's `generates` field that is produced by task execution and included in the stored cache.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A CI pipeline that uses store/restore completes a second run with unchanged inputs in less time than the first run, with task execution skipped for all tasks whose inputs have not changed.
- **SC-002**: After `hammerkit store <dir>`, all directories and files listed in any task's `generates` field are present inside `<dir>`.
- **SC-003**: After `hammerkit restore <dir>` followed by `hammerkit <task>`, the task execution log shows the task was skipped (cache hit) when inputs are unchanged.

## Assumptions

- The store command moves (rather than copies) generated outputs; the exact mechanism (move vs copy) is not critical to the observable contract but the doc says "moved".
- Only container-compatible and local task outputs that appear in `generates` are included; tasks without a `generates` field contribute nothing to the store.
- No `--filter`/`--exclude` options are documented for store/restore; the commands operate on all tasks in the build file.
- The cache directory path is relative to the working directory unless an absolute path is given; this mirrors standard shell behavior.
