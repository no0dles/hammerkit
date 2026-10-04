# Feature Specification: Variables from Command-line Arguments

**Feature Branch**: `release/1.11.0`

**Created**: 2026-10-04

**Status**: Implemented

**Input**: Migration feedback — narrowing a run (one test spec, one target) meant exporting shell variables or editing the build file; wrapper scripts existed only to set them.

## User Scenarios & Testing _(mandatory)_

1. **Given** `envs: { SPEC: ${E2E_SPEC:-all} }`, **When** `hammerkit run e2e --set E2E_SPEC=login`, **Then** the task sees `SPEC=login`.
2. **Given** the shell exports `E2E_SPEC=shell`, **When** the command also passes `--set E2E_SPEC=cli`, **Then** `cli` wins.
3. **Given** `--set` before or after the command name, or `--set=NAME=value`, **Then** it applies the same way; repeated `--set` set several variables.
4. **Given** `--set novalue` or `--set 1A=x`, **Then** the command fails with "--set expects NAME=value".

## Requirements _(mandatory)_

- **FR-001**: `--set NAME=value` is accepted by every command, taken out of the arguments before parsing (like `--file`).
- **FR-002**: The values resolve `$NAME` and `${NAME}` references ahead of the process environment and `.env` files.
- **FR-003**: A value is part of the cache key of the tasks that declare it, like any env value.
