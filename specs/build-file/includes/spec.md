# Feature Specification: Build File: Includes

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/build-file/includes.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reuse a shared task definition across multiple projects (Priority: P1)

In a monorepo with multiple packages that each have a `package.json`, a developer extracts the common `npm install` task into a shared `build.npm.yaml` file at the repo root. Each package's build file declares an `includes:` entry pointing to that shared file under the alias `npm`. The `npm:install` task is then available as a dependency in each package and executes with the working directory set to the package that included it — not the location of the shared file.

**Why this priority**: Includes are the canonical way to eliminate duplicated task definitions in monorepos; getting the working directory right is the core value proposition.

**Independent Test**: Create a shared build file with a task that writes a file. Include it in two different package build files. Run `hammerkit npm:install` from each package context and confirm the output file is written to the respective package directory, not the shared file's directory.

**Acceptance Scenarios**:

1. **Given** `build.npm.yaml` at the repo root defines task `install`, and `packages/a/.hammerkit.yaml` declares `includes: { npm: ../../build.npm.yaml }`, **When** the user runs `npm:install` in the context of package `a`, **Then** the task executes with the working directory set to `packages/a/`.
2. **Given** the same shared file is included in `packages/b/.hammerkit.yaml`, **When** `npm:install` runs in package `b`'s context, **Then** the working directory is `packages/b/`, independent of package `a`.
3. **Given** `packages/b/.hammerkit.yaml` declares `deps: [npm:install, a:build]`, **When** the build task runs, **Then** `npm:install` runs in `packages/b/`'s working directory and `a:build` runs as a reference with `packages/a/`'s working directory.

### Edge Cases

- Includes differ from references in that the working directory is the location of the including build file, not the location of the included file.
- Top-level `envs:` from the including build file are not visible to tasks in the included build file.
- An included file can itself declare further references, mixing the two mechanisms as shown in the monorepo example.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The build file MUST support a top-level `includes:` map where each key is an alias and each value is a path to a shared build YAML file.
- **FR-002**: Tasks from an included build file MUST be addressable using the `<alias>:<task-name>` notation from the CLI and in task `deps:` lists.
- **FR-003**: When a task from an included build file executes, the working directory MUST be the directory of the build file that declared the `includes:` entry, NOT the directory of the included file.
- **FR-004**: The same shared build file MAY be included by multiple build files, with each inclusion using the working directory of the including file independently.
- **FR-005**: Includes and references MAY be combined in the same build file, allowing tasks from included files to coexist with tasks from referenced sub-projects as dependencies.

### Key Entities

- **Include**: A named entry in the `includes:` map; the key is the alias used to prefix task names, the value is the relative path to the shared build YAML file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task sourced from an included build file runs with the working directory of the including project, not the directory where the shared file resides.
- **SC-002**: The same shared task file included by two different packages produces independent executions, each in their own package directory.
- **SC-003**: A build file that combines `includes:` and `references:` correctly resolves both sets of task namespaces and executes each with the correct working directory.

## Assumptions

- Include paths are relative to the directory of the build file containing the `includes:` block.
- Included files are standard hammerkit build YAML files and may contain any valid build file content (`tasks:`, `envs:`, etc.).
- The working-directory rule applies to all task types within an included file (container tasks and local tasks alike), though the docs only illustrate local tasks.
- Unlike references, includes do not require the target path to be a directory — they point directly to a `.yaml` file.
