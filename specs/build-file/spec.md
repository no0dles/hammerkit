# Feature Specification: Build File: Overview

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/build-file/README.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Define a project build file (Priority: P1)

A developer creates a `build.yaml` (or `.hammerkit.yaml`) file at the root of their project directory. They declare top-level environment variables, one or more named tasks, references to sub-projects, and includes for shared task files. They then invoke tasks by name via the hammerkit CLI.

**Why this priority**: The build file is the central configuration artifact; all other hammerkit features depend on it.

**Independent Test**: Create a minimal build file with a single task and verify `hammerkit <task>` executes it.

**Acceptance Scenarios**:

1. **Given** a project directory, **When** a `build.yaml` file is placed there with a valid `tasks:` block, **Then** hammerkit discovers and executes named tasks from that file via the CLI.
2. **Given** a build file with a top-level `envs:` block, **When** a task is run, **Then** the declared environment variables are available to the task commands.
3. **Given** a build file with `references:` and `includes:` blocks, **When** hammerkit starts, **Then** it loads the referenced and included build files and makes their tasks available under the appropriate namespaced names.

### Edge Cases

- A build file with no `tasks:` block is valid but produces no executable targets.
- The filename may be `build.yaml` or `.hammerkit.yaml`; behavior is identical.
- Top-level `envs:` are scoped to the build file where they are declared and do not propagate to referenced or included files.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST read build configuration from a YAML file named `build.yaml` or `.hammerkit.yaml` located in the project directory.
- **FR-002**: The build file MUST support a top-level `envs:` map for declaring environment variables shared across all tasks in that file.
- **FR-003**: The build file MUST support a top-level `tasks:` map where each key is a task name and the value is the task configuration.
- **FR-004**: The build file MUST support a top-level `references:` map pointing to other build files in sub-directories.
- **FR-005**: The build file MUST support a top-level `includes:` map pointing to shared build files whose tasks are merged under a namespace.
- **FR-006**: Tasks declared in a build file MUST be invocable by name via the hammerkit CLI.

### Key Entities

- **Build File**: A YAML file (`build.yaml` / `.hammerkit.yaml`) containing `envs`, `tasks`, `references`, and `includes` top-level keys.
- **Task**: A named unit of work inside the `tasks:` map; may declare commands, dependencies, source files, and generated outputs.
- **Reference**: A named pointer to another project directory containing its own build file.
- **Include**: A named pointer to a shared build YAML file whose tasks are reused with the working directory of the including file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A build file with all four top-level sections (`envs`, `tasks`, `references`, `includes`) loads without errors and all tasks are accessible via the CLI.
- **SC-002**: Environment variables defined in the top-level `envs:` block are resolved correctly within tasks in the same file and are not visible in referenced or included files.

## Assumptions

- The primary filename used in examples is `.hammerkit.yaml`; `build.yaml` is also accepted based on the docs description.
- The `caches:` top-level key (introduced in 1.6.0) exists in the build file schema but is covered by its own spec page.
- Task-level details (image, cmds, deps, src, generates) are covered by the Task spec pages, not this overview.
