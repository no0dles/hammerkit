# Feature Specification: Service Working Directory

**Feature Branch**: `feat/service-workdir`

**Created**: 2026-10-03

**Status**: Implemented

**Input**: Real-world migration of a Docker Compose e2e stack to hammerkit services. One of its API images starts with `exec node dist/index.js`, and another with `npm start` — both relative to the image's `WORKDIR`. Hammerkit runs every container service in the build file's directory, so neither image can start, and a service has no way to get its directory back (`cmd` only becomes arguments to the image's entrypoint).

## Motivation

Running services in the build file's directory is right for services built from the project (`deps: [install]`, `cmd: node server.js`): their files are mounted there. Third-party images are the opposite case: everything they need is inside the image, at their own `WORKDIR`. Compose keeps an image's `WORKDIR`; hammerkit overrode it with no opt-out, which blocked migrating such services.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a third-party image in its own directory (Priority: P1)

A developer sets `workdir` on a container service. The container starts in that directory, so an entrypoint using relative paths works.

**Independent Test**: A service serving its working directory over HTTP, with `workdir: /etc`, serves `/etc/alpine-release` to a task that needs it (`src/testing/integration/service-workdir.spec.ts`); without `workdir` the same check fails.

**Acceptance Scenarios**:

1. **Given** a container service with `workdir: /etc`, **When** it starts, **Then** its process runs in `/etc`.
2. **Given** a container service without `workdir`, **When** it starts, **Then** it runs in the build file's directory, as before.
3. **Given** `workdir: $DIR` and a build file env `DIR`, **When** the service is planned, **Then** the value is substituted.

### User Story 2 - Existing services keep their identity (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a service without `workdir`, **When** its id is computed, **Then** it equals the id computed before `workdir` existed.
2. **Given** two otherwise identical services, one with `workdir`, **Then** their ids differ.

## Requirements

- **FR-001**: Container services accept an optional string `workdir`, an absolute path inside the container; `$NAME` is substituted from the build file envs.
- **FR-002**: The Docker runtime sets the container's `WorkingDir`, the Kubernetes runtime the container's `workingDir`, to `workdir` when declared, else to the build file's directory (portable per ADR-0003).
- **FR-003**: `workdir` participates in the service id only when declared.
- **FR-004**: `hammerkit package` sets the declared `workdir` as the image's final `WORKDIR` (after the `COPY` steps, which stay relative to the build directory).
