# Feature Specification: Task: Extending

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/extending.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inherit a task from another build file (Priority: P1)

A developer in a monorepo has a shared `build.tsc.yaml` that defines standard `install` and `build` tasks. In each package's `.hammerkit.yaml` they write a task with `extend: tsc:build` to inherit all properties of the base task (sources, generates, commands, dependencies) with the working directory of the current file. This eliminates copy-pasting task definitions across packages.

**Why this priority**: Reducing duplication is the primary motivation for the extending feature and directly affects maintainability in larger projects.

**Independent Test**: Define a base task in an included file and a task that extends it with no overrides; run the extending task and verify it behaves identically to the base task.

**Acceptance Scenarios**:

1. **Given** a task with `extend: <namespace>:<task>` and no additional properties, **When** the task is run, **Then** it executes with all properties of the base task and the working directory of the current build file.
2. **Given** a task that extends a base task, **When** the base task defines `src`, `generates`, `deps`, and `cmds`, **Then** the extending task inherits all of those properties.

### User Story 2 - Override properties in an extended task (Priority: P1)

A developer extends a base task but needs to adjust specific properties — for example clearing all dependencies so the task runs standalone. They declare the overriding property alongside `extend`; the declared value replaces the inherited one.

**Why this priority**: Inheritance without override capability would force developers to extend-and-copy, defeating the purpose.

**Independent Test**: Extend a task that has `deps: [install]` and override with `deps: []`; run and verify the install task does not execute.

**Acceptance Scenarios**:

1. **Given** a task that extends a base task and declares `deps: []`, **When** the task is run, **Then** it runs without any dependency tasks, overriding the base `deps`.
2. **Given** a task that extends a base task and declares a new `cmds` list, **When** the task is run, **Then** the overriding commands execute, not the base commands.
3. **Given** a task that extends a base task and overrides only one property, **When** the task is run, **Then** all other properties are still inherited from the base task.

### Edge Cases

- The `extend` reference uses the `<namespace>:<task>` format where `namespace` matches an entry in the `includes` block of the same build file.
- Extending a task that itself extends another task (multi-level extend) is not described in the docs; behavior is not specified here.
- If the referenced base task or namespace does not exist, hammerkit should report an error at parse/plan time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept an `extend` field on a task whose value is a `<namespace>:<taskName>` reference to a task in an included build file.
- **FR-002**: A task with `extend` MUST inherit all properties of the referenced base task by default.
- **FR-003**: The working directory of an extending task MUST be the directory of the current build file, not the included file.
- **FR-004**: Any property declared on the extending task alongside `extend` MUST override the corresponding inherited property from the base task.
- **FR-005**: Properties not overridden on the extending task MUST retain their inherited values from the base task.

### Key Entities

- **Base task**: A task defined in an included build file that serves as a template.
- **Extending task**: A task in the current build file that references a base task via `extend` and optionally overrides specific properties.
- **Include**: A top-level `includes` entry mapping a namespace to a build file path, enabling the `<namespace>:<task>` reference syntax.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An extending task with no overrides produces the same observable behavior as running the base task directly, using the current file's working directory.
- **SC-002**: An extending task with `deps: []` runs without executing any dependency tasks, even when the base task declares dependencies.
- **SC-003**: An extending task that overrides one property inherits all other properties unchanged from the base task.

## Assumptions

- The `includes` block is required to bring the base file into scope under a namespace; the `extend` syntax `<namespace>:<task>` must match an entry in `includes`.
- Only a single level of extension is documented; chained extension (a base that itself extends another) is treated as out of scope for this spec.
- Property merging is a full replacement, not a deep merge — for example, overriding `deps` replaces the entire list, not appends to it.
