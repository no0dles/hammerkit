# Feature Specification: Build File: References

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/build-file/references.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a task from a referenced sub-project (Priority: P1)

A developer has a monorepo with multiple sub-directories, each containing its own build file. They declare a `references:` map in the root build file, giving each sub-project a short alias. They can then invoke tasks in those sub-projects from the CLI using the `<alias>:<task>` syntax, or declare them as dependencies in root tasks.

**Why this priority**: References are the primary mechanism for composing multi-project builds from a single entry-point build file.

**Independent Test**: Create a root build file with a reference to a sub-directory build file. Run `hammerkit <alias>:<task>` and confirm the task in the sub-project executes.

**Acceptance Scenarios**:

1. **Given** a root build file declares `references: { foo: project/foo }`, and `project/foo/.hammerkit.yaml` contains a task named `example`, **When** the user runs `hammerkit foo:example`, **Then** the `example` task from `project/foo` executes.
2. **Given** a root task declares `foo:example` in its `deps:`, **When** that root task runs, **Then** `foo:example` is executed as a prerequisite with the working directory fixed to `project/foo`.

### Edge Cases

- The working directory for tasks in a referenced build file is fixed to the directory where the referenced build file resides, not the directory of the referencing build file.
- Top-level `envs:` from the referencing build file are not visible to tasks in the referenced build file.
- Circular references (A references B which references A) are not discussed in the docs; behavior is assumed to be an error or undefined.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The build file MUST support a top-level `references:` map where each key is an alias and each value is a path to another project directory containing a build file.
- **FR-002**: Tasks from a referenced build file MUST be addressable using the `<alias>:<task-name>` notation from the CLI.
- **FR-003**: Tasks from a referenced build file MUST be usable as dependency entries in the referencing build file's task `deps:` list using the `<alias>:<task-name>` notation.
- **FR-004**: The working directory for tasks executing in a referenced build file MUST be the directory of that referenced build file, not the directory of the referencing file.

### Key Entities

- **Reference**: A named entry in the `references:` map; the key is the alias used to prefix task names, the value is the relative path to the sub-project directory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task in a referenced build file is successfully invoked via `hammerkit <alias>:<task>` and executes with the working directory set to the referenced project directory.
- **SC-002**: A task in the root build file that lists `<alias>:<task>` as a dependency causes that referenced task to run before the root task's commands execute.

## Assumptions

- The path in the `references:` value points to a directory, and hammerkit locates the build file (`build.yaml` or `.hammerkit.yaml`) within that directory automatically.
- Reference paths are relative to the directory of the build file containing the `references:` block.
- Deeply nested references (a reference to a build file that itself references another) are assumed to be supported, though not explicitly documented.
