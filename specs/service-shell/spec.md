# Feature Specification: Service Shell

**Feature Branch**: `feat/service-shell`

**Created**: 2026-10-03

**Status**: Implemented

**Input**: Real-world migration of a Docker Compose e2e stack to hammerkit services (contract-assistant). Compose-style service commands and healthchecks (`sh -c "…"`, `&&`, pipes, `$(…)`) had to be rewritten: a service `cmd` and a healthcheck `cmd` are tokenized into exec-form arguments with no shell, so a MongoDB replica-set initiation had to move into a separate JS file and multi-step readiness checks into single commands.

## Motivation

Tasks already run their commands through a configurable `shell`. Services didn't: their `cmd` became the container's exec-form command (arguments of the image entrypoint on Docker, the entrypoint itself on Kubernetes), and the healthcheck an exec of the tokenized command. Anything a shell provides — operators, substitutions, pipes — was unavailable, and the two runtimes interpreted `cmd` differently.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Shell commands for services (Priority: P1)

A developer sets `shell` on a container service. Its `cmd` runs as `<shell> -c "<cmd>"` in place of the image entrypoint, and its healthcheck as `<shell> -c "<healthcheck cmd>"`.

**Independent Test**: A service whose command uses `&&`, `$(uname -s)`, quotes and a loop, with a healthcheck combining `grep` and `nc` through `&&`, serves `ready on Linux` to a task that needs it (`src/testing/integration/service-shell.spec.ts`); without `shell` the same example fails.

**Acceptance Scenarios**:

1. **Given** a service with `shell` and `cmd`, **When** it starts, **Then** the container's entrypoint is `[shell, "-c"]` and its command `[cmd]` (Docker `Entrypoint`/`Cmd`, Kubernetes `command`/`args`, packaged image `ENTRYPOINT`/`CMD`).
2. **Given** a service with `shell` and a healthcheck, **When** readiness is checked, **Then** the check runs as `[shell, "-c", healthcheck cmd]` (Docker exec, Kubernetes exec probe).
3. **Given** a service with `shell` but no `cmd`, **Then** the image's entrypoint and command are kept.
4. **Given** a service without `shell`, **Then** behaviour is unchanged (exec form, image entrypoint kept on Docker).

### User Story 2 - Existing services keep their identity (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a service without `shell`, **When** its id is computed, **Then** it equals the id computed before `shell` existed.

## Requirements

- **FR-001**: Container services accept an optional string `shell`; `$NAME` is substituted from the build file envs.
- **FR-002**: With `shell`, `cmd` and the healthcheck run through it on the Docker runtime, the Kubernetes runtime and in `hammerkit package` images.
- **FR-003**: `shell` participates in the service id only when declared.
- **FR-004**: `hammerkit package` writes `ENTRYPOINT`/`CMD` JSON-encoded, so arguments containing quotes survive.
