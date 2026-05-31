# Feature Specification: CLI: clean

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/clean.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Remove generated outputs and local cache state for a clean rebuild (Priority: P1)

A developer suspects their build is producing stale results due to a previous cached state. They run `hammerkit clean` to delete all generated directories and files as well as hammerkit's per-task cache state for the current checkout, then re-run tasks to verify everything builds from scratch.

**Why this priority**: The primary purpose of `clean` is to reset local state so that builds are fully reproducible without prior artifacts.

**Independent Test**: Run a task that produces a `generates` output. Run `hammerkit clean`. Confirm the generated output no longer exists and that hammerkit re-executes the task on the next run regardless of unchanged inputs.

**Acceptance Scenarios**:

1. **Given** tasks have been run and generated outputs and cache state exist, **When** `hammerkit clean` is run, **Then** all generated outputs and per-task local cache state are removed.

2. **Given** `hammerkit clean` has completed, **When** a task is run again with unchanged inputs, **Then** hammerkit re-executes the task because the local cache state is absent.

### User Story 2 - Drop stored remote/backend cache results to force a full rebuild (Priority: P2)

A developer encounters a persistent caching issue and needs to force the next run to rebuild from scratch even against a configured cache backend (local result store or remote, e.g. S3). They run `hammerkit clean --cache` to also purge stored results from the backend.

**Why this priority**: The `--cache` flag addresses a deeper reset need when the standard clean is insufficient due to a populated cache backend.

**Independent Test**: Configure a cache backend. Run tasks so results are stored in the backend. Run `hammerkit clean --cache`. Confirm the backend has no stored results for the project and that the next run rebuilds all tasks.

**Acceptance Scenarios**:

1. **Given** a configured cache backend with stored task results, **When** `hammerkit clean --cache` is run, **Then** the stored results in the backend (local `~/.hammerkit/remote-cache` or remote) are deleted in addition to generated outputs and local cache state.

2. **Given** `--cache` is omitted, **When** `hammerkit clean` is run, **Then** stored results in the cache backend are preserved; only local generated outputs and per-task cache state are removed.

### User Story 3 - Clean a subset of tasks and services using label filters (Priority: P2)

A developer wants to clean only a specific subset of tasks without affecting others. They use `--filter` or `--exclude` with label selectors to target or omit specific tasks and services.

**Why this priority**: Label-scoped clean reduces disruption to unrelated tasks in large build files.

**Independent Test**: Tag two tasks with different labels. Run both. Run `hammerkit clean --filter <label>`. Confirm only the filtered task's outputs and cache state are removed while the other task's outputs remain.

**Acceptance Scenarios**:

1. **Given** tasks are labeled, **When** `hammerkit clean --filter <label>` is run, **Then** only the tasks and services matching the label are cleaned.

2. **Given** tasks are labeled, **When** `hammerkit clean --exclude <label>` is run, **Then** tasks and services matching the label are skipped and all others are cleaned.

### Edge Cases

- Running `hammerkit clean` when no tasks have been run (no generated outputs, no cache state) should complete without error.
- `hammerkit clean --cache` removes the local result store at `~/.hammerkit/remote-cache` or a configured remote backend, not just the per-checkout cache state.
- Label filters apply to both tasks and services, consistent with their behavior in other commands.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST remove all generated outputs (files and directories declared via `generates`) for all tasks and services in the current checkout when `hammerkit clean` is run.
- **FR-002**: System MUST remove the per-task local cache state for the current checkout when `hammerkit clean` is run.
- **FR-003**: When `--cache` is supplied, system MUST additionally delete stored results from the configured cache backend (defaulting to `~/.hammerkit/remote-cache` for local backends).
- **FR-004**: System MUST support `-f`/`--filter` and `-e`/`--exclude` label options to restrict which tasks and services are cleaned.
- **FR-005**: System MUST complete without error when there are no generated outputs or cache state to remove.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `hammerkit clean`, no generated output directories or files from any task's `generates` field exist in the working tree.
- **SC-002**: After `hammerkit clean`, running any task re-executes it fully regardless of whether its inputs have changed.
- **SC-003**: After `hammerkit clean --cache`, the cache backend contains no stored results for the project and the next run rebuilds all tasks from source.
- **SC-004**: After `hammerkit clean --filter <label>`, only tasks matching the label have their outputs and cache state removed; all other task outputs remain intact.

## Assumptions

- "Per-task cache state" refers to the hammerkit-internal tracking of input hashes used to determine whether a task is up to date; this is distinct from stored build results in the cache backend.
- The `--cache` flag targets whatever backend is configured in the build file's `caches` section, defaulting to the local result store at `~/.hammerkit/remote-cache`.
- The `clean` command does not prompt for confirmation; it is destructive by design.
- There is no `--dry-run` option documented; the command always performs the deletion.
