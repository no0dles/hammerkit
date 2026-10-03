# Feature Specification: Warn About Unreferenced Build-File Envs

**Feature Branch**: `feat/task-env-scope`

**Created**: 2026-10-03

**Status**: Implemented

**Input**: Migration feedback — adding an image variable to the build-file `envs` invalidated `install` and every task after it, because every build-file env is part of every task's key. The workaround was to inline the image everywhere.

## Decision

Build-file `envs` stay in every task's key. They are passed to every task's process, and hammerkit can't see what a tool reads at runtime (`NODE_ENV`, `YARN_*`), so dropping unreferenced ones from the key would produce stale cache hits. Instead, `validate` points at the churn.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See which build-file envs churn a task's key (Priority: P1)

**Acceptance Scenarios**:

1. **Given** build-file `envs` `NODE_IMAGE` and `TOKEN` and a task with commands that mentions only `$NODE_IMAGE`, **When** `hammerkit validate` runs, **Then** it warns once for the task, naming `TOKEN`.
2. **Given** a task that mentions an env as `$NAME` or `${NAME}` in any field (any case), or defines it in its own `envs`, **Then** that env is not reported. `$NAME_SUFFIX` does not count as a reference to `$NAME`.
3. **Given** an aggregate task (no `cmds`), a task that `extend`s another, or a task whose schema can't be found (matrix instances), **Then** nothing is reported.

### User Story 2 - Readable validate output (Priority: P2)

1. **Given** several findings, **When** `validate` runs, **Then** each finding is printed once (the findings used to be re-printed cumulatively after each one).

## Requirements _(mandatory)_

- **FR-001**: Cache identity is unchanged.
- **FR-002**: The warning is advisory and doesn't change the exit code.
