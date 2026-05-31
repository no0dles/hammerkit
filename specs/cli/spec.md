# Feature Specification: CLI: Overview

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/cli/README.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Running hammerkit for the first time (Priority: P1)

A developer downloads hammerkit and runs `hammerkit --help` to discover what commands are available. They see the full command list and global options, understand how to specify a custom build file, and know how to turn on verbose logging.

**Why this priority**: The CLI entry point and help text are the first thing every user sees; a broken or incomplete help surface breaks all downstream workflows.

**Independent Test**: Run `hammerkit --help` in a directory that contains a `.hammerkit.yaml` file and verify the output lists all commands and global options.

**Acceptance Scenarios**:

1. **Given** a directory with a valid `.hammerkit.yaml`, **When** the user runs `hammerkit --help`, **Then** the output includes the version flag (`-V, --version`), `--verbose`, `--file`, and all subcommands (`ls`, `clean`, `store`, `restore`, `package`, `validate`, `up`, `down`, `run`, `help`).

2. **Given** any directory, **When** the user runs `hammerkit --version`, **Then** the current version number is printed.

3. **Given** a directory with a valid build file, **When** the user runs `hammerkit --file custom.yaml <task>`, **Then** hammerkit uses `custom.yaml` as the build file instead of `.hammerkit.yaml`.

4. **Given** a directory without a build file, **When** the user runs any command other than `init`, **Then** hammerkit reports that no build file is present and only the `init` command is available.

### User Story 2 - Enabling verbose output (Priority: P2)

A developer is troubleshooting an unexpected task result and wants to see internal debugging information. They add `--verbose` before the command and observe additional log lines.

**Why this priority**: Debugging is a high-frequency need but not the primary happy path.

**Independent Test**: Run `hammerkit --verbose ls` and confirm that extra debug-level log lines appear beyond what the default output produces.

**Acceptance Scenarios**:

1. **Given** a valid build file, **When** the user runs `hammerkit --verbose ls`, **Then** the output contains debugging information in addition to the normal task list.

### Edge Cases

- When no build file is found, hammerkit must restrict available commands to `init` only and surface a helpful message.
- The `--file` flag accepts any path; if the file does not exist, hammerkit must report an error.
- Global options (`--verbose`, `--file`) must be accepted before the subcommand name.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a global `--verbose` flag that enables debug-level logging for any subcommand.
- **FR-002**: System MUST provide a global `--file <path>` option that overrides the default build file path (`.hammerkit.yaml`).
- **FR-003**: System MUST expose the following subcommands: `ls`, `clean`, `store`, `restore`, `package`, `validate`, `up`, `down`, `run`, `help`.
- **FR-004**: System MUST treat `hammerkit <task>` (no explicit subcommand) as equivalent to `hammerkit run <task>` (default command).
- **FR-005**: System MUST print the installed version when `--version` / `-V` is supplied.
- **FR-006**: System MUST restrict available commands to `init` when no build file is present in the working directory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `hammerkit --help` exits with code 0 and lists all documented commands and global options.
- **SC-002**: `hammerkit --version` exits with code 0 and prints a semantic version string.
- **SC-003**: `hammerkit --file <nonexistent>` exits with a non-zero code and a human-readable error message.
- **SC-004**: Running `hammerkit <task>` without the `run` keyword produces identical output to `hammerkit run <task>`.

## Assumptions

- The default build file name is `.hammerkit.yaml` (as shown in the CLI help output).
- "Only `init` is available" when no build file is present means hammerkit exits with an error for all other commands, not that it silently ignores them.
- `--verbose` applies globally to all subcommands; per-command verbosity overrides are not documented.
