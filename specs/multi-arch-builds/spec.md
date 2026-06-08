# Feature Specification: Multi-Arch Container Builds

**Feature Branch**: `009-multi-arch-builds`

**Created**: 2026-05-31

**Status**: Draft (stretch)

**Input**: 1.7 brainstorm — let `hammerkit package <registry>` produce a multi-platform image (e.g. linux/amd64 + linux/arm64) and push a manifest list, instead of a single-arch image. Flagged as a stretch item because it has a real tooling dependency (multi-arch builds need BuildKit/buildx, which the current dockerode-based path does not provide).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Package a multi-arch image (Priority: P1)

A developer declares target `platforms` for a packaged image and runs `hammerkit package <registry>`. Hammerkit builds the image for each platform and pushes a single manifest list, so consumers on amd64 and arm64 both pull a working image.

**Why this priority**: Mixed-arch fleets (Apple Silicon laptops, arm64 CI/cloud) are now common; a single-arch artifact silently fails on the other arch.

**Independent Test**: Package a service with `platforms: [linux/amd64, linux/arm64]` to a local registry and verify the pushed tag resolves to a manifest list containing both platforms.

**Acceptance Scenarios**:

1. **Given** a service/package with `platforms` declared, **When** `hammerkit package <registry>` runs, **Then** an image is produced for each declared platform.
2. **Given** a successful multi-arch package, **When** the result is pushed, **Then** the registry tag is a manifest list referencing every declared platform.
3. **Given** no `platforms` declared, **When** packaging runs, **Then** behavior is unchanged (single-arch, host platform).

### Edge Cases

- The host cannot natively build a foreign architecture → requires emulation (e.g. qemu/binfmt); hammerkit MUST detect the missing capability and produce a clear, actionable error rather than a confusing low-level failure.
- A target registry that does not support manifest lists → clear error.
- A platform string that is malformed or unsupported → validation error naming the bad value.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A package/service MUST accept an optional `platforms` list (e.g. `linux/amd64`, `linux/arm64`).
- **FR-002**: The system MUST build the image for each declared platform and push a manifest list referencing all of them.
- **FR-003**: When no `platforms` are declared, behavior MUST be unchanged — single-arch for the host platform (additive, non-breaking — Stable Contracts).
- **FR-004**: When the environment lacks the capability to build a declared platform, the system MUST fail with a clear, actionable message (what is missing and how to enable it).
- **FR-005**: Malformed/unsupported platform strings MUST be rejected at validation time.

### Key Entities

- **Platform target**: an OS/arch pair (and optional variant), e.g. `linux/arm64/v8`.
- **Manifest list**: the multi-platform image index pushed to the registry, referencing one image per platform.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A package with two declared platforms produces a registry tag that resolves to a manifest list with both.
- **SC-002**: Pulling the pushed tag on each target architecture yields a runnable image for that architecture.
- **SC-003**: A package with no `platforms` produces the same single-arch artifact as the prior version.

## Assumptions

- **Key open question — build mechanism**: multi-arch builds require BuildKit/buildx semantics that the current dockerode build path does not provide. [NEEDS CLARIFICATION: depend on a `docker buildx` binary, drive BuildKit directly, or build per-arch and assemble the manifest list via the registry API. Resolve before implementation — this choice gates the whole feature and must respect "platform-agnostic" / "no external binary unless justified".]
- Cross-arch builds assume host emulation is available or the build runs on native runners per arch; hammerkit's job is to surface the requirement clearly, not to install emulation.
- This spec is scoped to the `package`/image-build path, not to per-task run images (running a foreign-arch task is a separate concern via emulation and out of scope here).
