# Feature Specification: CLI: ls

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/ls.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discovering available tasks and services (Priority: P1)

A developer opens a project they are unfamiliar with and wants to understand what build tasks and services are defined before running anything. They run `hammerkit ls` and see a structured list of all services and tasks with their key attributes: ports, images, labels, source files, generated outputs, and inter-task dependencies.

**Why this priority**: `ls` is the primary discovery and onboarding command; it must accurately reflect the build file content so users know what they can run.

**Independent Test**: Given a build file containing at least one service and one task, run `hammerkit ls` and verify that both sections appear with correct attribute values.

**Acceptance Scenarios**:

1. **Given** a build file with a service `postgres` bound to port `5432` using image `postgres:12`, **When** the user runs `hammerkit ls`, **Then** the output contains a `Services:` section listing `postgres` with its port mapping (`127.0.0.1:5432 -> 5432`) and image.

2. **Given** a build file with a task `install` that has an image, labels, src files, and generated outputs, **When** the user runs `hammerkit ls`, **Then** the output contains a `Tasks:` section listing `install` with all those attributes displayed.

3. **Given** a build file with a task `api` that declares `needs: postgres` and `deps: install`, **When** the user runs `hammerkit ls`, **Then** the output for `api` shows both the `needs` (service dependency) and `deps` (task dependency) fields.

4. **Given** a build file with only tasks and no services, **When** the user runs `hammerkit ls`, **Then** the output contains only a `Tasks:` section with no `Services:` section.

### Edge Cases

- A build file with no tasks and no services should produce empty or minimal output without crashing.
- Labels with multiple key=value pairs must all appear on the same `labels:` line.
- Tasks with multiple source files or generated outputs must list them space-separated.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST print a `Services:` section listing every service defined in the build file, each preceded by a bullet (`•`).
- **FR-002**: For each service, system MUST display the port mappings and container image.
- **FR-003**: System MUST print a `Tasks:` section listing every task defined in the build file, each preceded by a bullet (`•`).
- **FR-004**: For each task, system MUST display the container image, labels (if any), source files (if any), generated outputs (if any), service dependencies via `needs:` (if any), and task dependencies via `deps:` (if any).
- **FR-005**: System MUST omit attributes that are not set for a given task or service (no empty lines for unset fields).

### Key Entities

- **Service**: A long-running container dependency (e.g., a database) with port mappings and an image.
- **Task**: A build step with an image, optional labels, source globs, generated paths, and optional dependencies on other tasks or services.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `hammerkit ls` exits with code 0 for any valid build file.
- **SC-002**: Every service and task name defined in the build file appears exactly once in the `hammerkit ls` output.
- **SC-003**: Port mappings shown in the output match the bind address and container port declared in the build file.
- **SC-004**: Label values shown in the output match the `key=value` pairs declared in the build file.

## Assumptions

- `ls` reads the default build file (`.hammerkit.yaml`) unless `--file` is supplied globally.
- No filtering options are documented for `ls`; it always prints all services and all tasks.
- The output format is plain text (not JSON or YAML) with a bullet-point layout as shown in the docs example.
- The `Services:` section is printed before the `Tasks:` section when both are present.
