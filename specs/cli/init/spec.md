# Feature Specification: CLI: init

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/init.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bootstrapping a new project (Priority: P1)

A developer starts a brand-new project and wants to adopt hammerkit. They run `hammerkit init` in the project root, which creates a ready-to-edit `.hammerkit.yaml` with a working example task and appends the hammerkit cache directory to `.gitignore` so build artifacts are not accidentally committed.

**Why this priority**: `init` is the mandatory first step for every new hammerkit user; without it the rest of the tool cannot be used.

**Independent Test**: In an empty directory, run `hammerkit init` and verify that `.hammerkit.yaml` and `.gitignore` are created (or updated) with the documented content.

**Acceptance Scenarios**:

1. **Given** an empty directory with no existing build file, **When** the user runs `hammerkit init`, **Then** a `.hammerkit.yaml` file is created containing an `envs: {}` block, a `tasks:` block with an `example` task using the `alpine` image and the command `echo "it's Hammer Time!"`.

2. **Given** an empty directory with no existing `.gitignore`, **When** the user runs `hammerkit init`, **Then** a `.gitignore` file is created containing the entry `.hammerkit`.

3. **Given** a directory that already has a `.gitignore`, **When** the user runs `hammerkit init`, **Then** the `.hammerkit` entry is appended to the existing `.gitignore` without overwriting other entries.

4. **Given** a directory that already has a `.hammerkit.yaml`, **When** the user runs `hammerkit init`, **Then** the command succeeds (or warns) without overwriting the existing build file.

### Edge Cases

- If the user lacks write permissions in the working directory, `init` must exit with a non-zero code and a meaningful error message.
- Running `init` when a `.hammerkit.yaml` already exists must not destroy existing configuration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST create a `.hammerkit.yaml` file in the current working directory when `hammerkit init` is run and no build file exists.
- **FR-002**: The generated `.hammerkit.yaml` MUST contain an `envs: {}` key and a `tasks:` key with at least one example task using the `alpine` image.
- **FR-003**: System MUST create or update a `.gitignore` file in the current working directory to include the `.hammerkit` cache directory entry.
- **FR-004**: System MUST print confirmation output indicating each file that was created or updated, including the file path.

### Key Entities

- **Build file (`.hammerkit.yaml`)**: The hammerkit project configuration file. Created by `init` with a minimal, runnable example task.
- **Cache directory entry (`.hammerkit`)**: The directory hammerkit uses for local caching; excluded from version control via `.gitignore`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `hammerkit init`, the file `.hammerkit.yaml` exists in the working directory and is parseable as valid YAML with the documented structure.
- **SC-002**: After `hammerkit init`, the file `.gitignore` in the working directory contains the line `.hammerkit`.
- **SC-003**: `hammerkit init` exits with code 0 and prints at least two confirmation lines (one per created/updated file).
- **SC-004**: Running `hammerkit run example` immediately after `hammerkit init` in a Docker-enabled environment succeeds without manual editing.

## Assumptions

- `init` creates files relative to the current working directory (not a project-root detection heuristic).
- The console confirmation output format is a checkmark prefix followed by the absolute path of each file, as shown in the docs example.
- If `.hammerkit.yaml` already exists, `init` skips creation rather than overwriting; this is an informed guess based on the "non-destructive bootstrap" intent.
- The `--file` global option does not affect where `init` writes the build file; it always writes `.hammerkit.yaml`.
