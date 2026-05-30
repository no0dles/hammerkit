# Feature Specification: Task: Container

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/task/container.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a task inside a container image (Priority: P1)

A developer wants to build their project without installing Node.js locally. They add `image: node:14.16.0` to the task definition and hammerkit executes the task's commands inside a container using that image.

**Why this priority**: Container execution is the core cross-platform isolation feature of hammerkit.

**Independent Test**: Define a task with `image` set and a command that prints the Node version; verify the output matches the version in the image, not any locally installed Node.

**Acceptance Scenarios**:

1. **Given** a task with an `image` property, **When** the task is run, **Then** all commands execute inside a container created from that image.
2. **Given** a task with `image` but no `src` or `mounts`, **When** the task runs, **Then** the container has no access to host files.

### User Story 2 - Make source files available inside the container (Priority: P1)

A developer's container task needs to read project files. They declare those files and folders in `src`; hammerkit mounts them into the container automatically so commands can access them.

**Why this priority**: Without file access the container task cannot read inputs and is not useful.

**Independent Test**: Add `src` files to a container task and verify a command inside the container can read those files.

**Acceptance Scenarios**:

1. **Given** a container task with `src` files listed, **When** the task executes, **Then** those files are accessible at their expected paths inside the container.
2. **Given** a container task whose dependency task declares `src` and `generates`, **When** the dependent task executes, **Then** those dependency paths are also mounted automatically without being listed again.

### User Story 3 - Persist output files across runs using generates (Priority: P2)

A developer's container task produces `node_modules`. They declare `node_modules` under `generates` so hammerkit persists it in a container volume between runs, enabling caching of the installed packages.

**Why this priority**: Without `generates`, outputs are lost when the container exits; re-runs would redo all work.

**Independent Test**: Run an install task in a container with `node_modules` in `generates`; stop hammerkit and run again — the second run should be cached and `node_modules` should still be present.

**Acceptance Scenarios**:

1. **Given** a container task with a path in `generates`, **When** the task completes, **Then** the output is preserved in a container volume for the next run.
2. **Given** a container task with `generates` and `export: true`, **When** the task completes, **Then** the generated files are also copied to the host workspace.

### User Story 4 - Mount additional files and directories (Priority: P2)

A developer needs to give the container access to files that are neither source inputs nor generated outputs (e.g., a credential file or a shared cache directory). They use `mounts` with relative paths, absolute paths, or `$PWD`-relative expressions.

**Why this priority**: Not all container inputs fit the source/generate model; mounts fill that gap.

**Independent Test**: Add a mount to a container task and verify the mounted path is accessible inside the container.

**Acceptance Scenarios**:

1. **Given** a container task with a relative `mounts` entry, **When** the task runs, **Then** the relative path is mounted into the container.
2. **Given** a container task with an absolute `mounts` entry, **When** the task runs, **Then** the absolute path is mounted into the container.
3. **Given** a container task with a `$PWD`-style `mounts` entry (e.g., `$PWD/.npm:/.npm`), **When** the task runs, **Then** the path is expanded and mounted at the specified target path.

### User Story 5 - Override the execution shell (Priority: P3)

A developer's commands require bash-specific syntax. They set `shell: bash` on the task and commands are invoked with bash instead of the default `sh`.

**Why this priority**: Some commands or scripts require a specific shell; the default `sh` is too restrictive for some use cases.

**Independent Test**: Set `shell: bash` and use a bash-only feature (`$RANDOM`); verify the command succeeds inside the container.

**Acceptance Scenarios**:

1. **Given** a container task with `shell: bash`, **When** a command uses bash-specific syntax, **Then** it executes successfully.
2. **Given** a container task without a `shell` property, **When** commands run, **Then** they are executed with `sh`.

### Edge Cases

- A container task with no `src`, `generates`, or `mounts` can still run but has no access to host files.
- File permissions: commands in a container run with the same UID/GID as the local user; hammerkit sets the owner of the working directory and all mounts to that UID/GID before each task run.
- Sources and generates of all dependency tasks are automatically mounted; this reduces the need for explicit `mounts` entries.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept an `image` property on a task and execute all `cmds` inside a container created from that image.
- **FR-002**: The system MUST mount all `src` files and directories into the container at task startup so they are accessible inside the container.
- **FR-003**: The system MUST persist paths listed in `generates` in a container volume across runs.
- **FR-004**: The system MUST automatically mount the `src` and `generates` paths of all dependency tasks into a dependent container task.
- **FR-005**: The system MUST accept a `mounts` list supporting relative paths, absolute paths, and `$PWD`-prefixed expressions with optional target path suffixes.
- **FR-006**: The system MUST default to `sh` as the command execution shell for container tasks.
- **FR-007**: The system MUST accept a `shell` property on a task to override the execution shell.
- **FR-008**: The system MUST run container commands with the same UID/GID as the host user and set ownership of the working directory and mounts accordingly before each run.

### Key Entities

- **Container task**: A task with an `image` property. Additional attributes: `shell` (optional), `mounts` (optional list), `src` (optional), `generates` (optional).
- **Mount entry**: A string specifying a host path (relative, absolute, or `$PWD`-prefixed) optionally followed by `:` and a container target path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A container task command that prints the runtime version outputs the version from the declared image, not the host.
- **SC-002**: Files listed in `src` are readable inside the container during task execution.
- **SC-003**: A path listed in `generates` persists between separate hammerkit invocations without requiring re-installation.
- **SC-004**: A container task with `export: true` on a generate path results in that directory appearing on the host filesystem after the run.
- **SC-005**: Files created inside the container are owned by the host user's UID/GID on the host filesystem.

## Assumptions

- Container execution uses the local Docker daemon unless an environment is selected (see kubernetes.md).
- The working directory inside the container mirrors the host project directory structure.
- `$PWD` in mount expressions is expanded to the host working directory at task execution time.
- The `export` and `resetOnChange` flags on generate entries are described on the Task Overview page and apply equally to container tasks.
