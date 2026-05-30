# Feature Specification: Labels: Overview

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/labels/README.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filtering tasks to run only a matching subset (Priority: P1)

A developer works in a monorepo with tasks for multiple projects. They tag each task with a `project` label and run `hammerkit task -f project=a` to execute only the tasks (and their dependencies) that carry that label.

**Why this priority**: Label-based task filtering is the primary value proposition of labels — enabling targeted runs in complex build files without manually listing task names.

**Independent Test**: Declare tasks `build-a` and `build-b` with labels `project: a` and `project: b` respectively. Run `hammerkit -f project=a` and confirm only tasks with `project=a` (and their deps) are executed, not `build-b`.

**Acceptance Scenarios**:

1. **Given** tasks with different `project` label values, **When** `hammerkit -f project=a` is executed, **Then** only tasks whose `project` label equals `a` are included in the run.

2. **Given** a task with label `project: a` has a dependency task without any labels, **When** `hammerkit -f project=a` is run, **Then** the unlabelled dependency is still executed as part of the filtered run.

### User Story 2 - Excluding tasks by label (Priority: P1)

A CI pipeline runs on two separate runners — one macOS, one Linux. The macOS runner should skip all non-iOS tasks. The operator uses `hammerkit -e platform=ios` on the Linux runner to exclude all tasks labelled `platform: ios`.

**Why this priority**: Exclusion (`-e`) is equally important to inclusion (`-f`) for CI matrix setups and is documented side-by-side.

**Independent Test**: Declare tasks with and without `platform: ios`. Run `hammerkit -e platform=ios` and confirm tasks labelled `platform: ios` are skipped while unlabelled tasks run.

**Acceptance Scenarios**:

1. **Given** a mix of tasks with and without `platform: ios`, **When** `hammerkit -e platform=ios` is run, **Then** tasks with `platform: ios` are excluded and all other tasks proceed normally.

2. **Given** the macOS runner uses `hammerkit -f platform=ios`, **When** executed, **Then** only tasks labelled `platform: ios` run on that host.

### User Story 3 - Grouping unrelated tasks under a common label for parallel or sequential execution (Priority: P2)

A developer wants a single command to start both an API server and a frontend watcher that have no dependency between them. They assign both a `task: dev` label and run `hammerkit -f task=dev` to start them together.

**Why this priority**: Grouping by purpose simplifies developer workflows and reduces the need to remember multiple task names.

**Independent Test**: Declare two independent tasks with `task: dev`. Run `hammerkit -f task=dev` and verify both tasks are executed in the same run.

**Acceptance Scenarios**:

1. **Given** two independent tasks share `task: dev`, **When** `hammerkit -f task=dev` is executed, **Then** both tasks run in the same invocation.

2. **Given** tasks labelled `task: release` are also present, **When** `hammerkit -f task=dev` is run, **Then** release tasks are not executed.

### Edge Cases

- A label is a key-value pair; both key and value must be specified in filter/exclusion flags (e.g. `-f project=a`, not `-f project`).
- Labels can be defined at the task level or at the build-file level (build-file-level labels apply to all tasks in that file).
- When using store/restore across CI hosts with label-filtered runs, the `store` and `restore` commands accept the same `-f`/`-e` label arguments (e.g. `hammerkit store -e platform=ios`).
- A task with no labels is included in runs that use `-f` only if it is a dependency of a matching task; it is never excluded by `-e` (since it has no matching label).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support defining labels as key-value pairs on individual tasks.
- **FR-002**: System MUST support defining labels at the build-file level, applying them to all tasks in that file.
- **FR-003**: System MUST provide a `-f <key>=<value>` CLI flag that restricts the run to tasks whose labels include the specified key-value pair (and their dependencies).
- **FR-004**: System MUST provide a `-e <key>=<value>` CLI flag that excludes tasks whose labels include the specified key-value pair from the run.
- **FR-005**: System MUST apply `-f` and `-e` label arguments to `store` and `restore` CLI commands in addition to task execution commands.
- **FR-006**: System MUST still execute unlabelled dependency tasks required by label-matched tasks when `-f` filtering is active.

### Key Entities

- **Label**: A key-value pair attached to a task or build file. Both key and value are strings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Running with `-f <key>=<value>` results in only tasks carrying that label (and their transitive dependencies) being executed, confirmed by execution logs.
- **SC-002**: Running with `-e <key>=<value>` results in no task carrying that label being executed, confirmed by execution logs.
- **SC-003**: Build files with overlapping task graphs (monorepo scenario) can be filtered to isolated subsets using a single label flag without editing the build file.
- **SC-004**: `hammerkit store -e platform=ios` and `hammerkit store -f platform=ios` honour the same label filtering logic as task execution.

## Assumptions

- Labels are case-sensitive for both key and value comparisons.
- Multiple `-f` or `-e` flags in a single invocation are assumed to be AND-combined (all specified labels must match), though the docs do not explicitly state this; noted as an assumption.
- Build-file-level labels are inherited by all tasks in the file but can be overridden at the task level; the docs mention both scopes without describing conflict resolution, so this is assumed additive (file labels + task labels merge).
- Labels are metadata only and have no effect on task execution order beyond determining which tasks are included or excluded.
