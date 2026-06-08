# Feature Specification: Remote Includes & References (git)

**Feature Branch**: `010-remote-includes`

**Created**: 2026-05-31

**Status**: Draft (model resolved — ADR-0004)

**Input**: 1.7 brainstorm — let `references`/`includes` resolve a build file from a remote **git** repository, so shared best-practice build files can be distributed and reused across projects. The repo's own `best-practices/` collection (`build.npm.yaml`, `build.tsc.yaml`, `build.helm.yaml`, …) is exactly the kind of content this distributes.

## Resolved model (ADR-0004)

- **Transport: git only** (no HTTP).
- **Refs: mutable allowed** — a reference may use a branch, a tag, or a commit SHA.
- **No lockfile.** The first resolution fetches the repo at the ref and caches it locally; later runs use the cached copy (stable run-to-run, including offline). The **cache is the pin**.
- **Refresh on demand** — a dedicated pull command (and `hammerkit clean --cache`) re-fetches the latest for mutable refs.
- **Reproducibility opt-in** — a commit SHA pins exact content; a branch/tag is frozen only in the per-machine cache, so the included file can drift across machines (documented trade-off).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reference a best-practice file from git (Priority: P1)

A developer points a reference at a build file in a git repository (at a branch, tag, or commit, optionally at a subpath) and uses its tasks as if they were local.

**Why this priority**: The core distribution path; unlocks sharing immediately.

**Independent Test**: Reference `build.helm.yaml` in a git repo at `main`, run a task it defines, and verify it executes from the remote definition.

**Acceptance Scenarios**:

1. **Given** a `references` entry pointing at a git repo + ref + subpath, **When** a task from it runs, **Then** hammerkit fetches the repo at that ref and runs the task from its definition.
2. **Given** an existing local-path `references`/`includes` entry, **When** the build runs, **Then** behavior is unchanged (local resolution still works).

### User Story 2 - Cached locally, stable and offline (Priority: P1)

Once fetched, a remote reference is cached locally; subsequent runs use the cache without re-fetching, including offline. The cache is the pin, so runs are stable until refreshed.

**Why this priority**: Local-first — a build must not require network access on every run, and must not silently change underfoot.

**Independent Test**: Resolve a remote reference online, disconnect the network, run again — it resolves from cache and succeeds; the content is identical to the first run.

**Acceptance Scenarios**:

1. **Given** a previously resolved remote reference present in the local cache, **When** the network is unavailable, **Then** the build resolves it from cache and proceeds.
2. **Given** a cached remote reference, **When** the build runs again with no refresh, **Then** it uses the same cached content (no re-fetch).

### User Story 3 - Refresh the cache on demand (Priority: P1)

A developer runs a pull command to re-fetch remote references (picking up the latest commit for a mutable ref); `hammerkit clean --cache` also purges them so the next run re-pulls.

**Why this priority**: Mutable refs are only useful if there's a deliberate way to update them.

**Independent Test**: Reference a branch, cache it, advance the branch upstream, run the refresh command — the cache now holds the new commit's content.

**Acceptance Scenarios**:

1. **Given** a cached reference to a mutable ref whose upstream has advanced, **When** the refresh/pull command runs, **Then** the cache is updated to the latest commit.
2. **Given** a cached reference, **When** `hammerkit clean --cache` runs, **Then** the cached remote file is purged and the next run re-fetches it.

### User Story 4 - Pin a commit for reproducibility (Priority: P2)

A developer references a commit SHA to guarantee identical content on every machine and CI run.

**Why this priority**: The escape hatch for teams that need cross-machine reproducibility of the included file.

**Independent Test**: Reference a SHA; two machines resolve byte-identical content regardless of cache state.

**Acceptance Scenarios**:

1. **Given** a reference pinned to a commit SHA, **When** two machines resolve it, **Then** they obtain identical content.
2. **Given** a SHA-pinned reference, **When** the refresh command runs, **Then** the content does not change (the SHA is immutable).

### Edge Cases

- Repo/ref unreachable **and** not cached → clear error naming the repo and ref; no silent fallback.
- Repo/ref unreachable but **cached** → use the cache (offline path).
- A remote file with its own relative `references`/`includes` or relative paths → resolved within the **same repo at the same commit** (git clone makes this trivial).
- **Mutable-ref drift across machines** → accepted and documented: a fresh CI cache pulls current branch HEAD while a stale cache holds older content. Use a commit SHA for reproducibility.
- Private repo → standard git credential helpers; no new hammerkit secret surface.
- Resolution executes nothing — a remote file contributes definitions only; commands run when a task is invoked.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `references`/`includes` values MUST accept a **git** source (repo + ref where ref is a branch, tag, or commit SHA, plus an optional subpath), in addition to a local path.
- **FR-002**: Existing local-path values MUST resolve exactly as today (additive, non-breaking — Stable Contracts).
- **FR-003**: The first resolution MUST fetch the repo at the ref and cache it locally; subsequent runs MUST use the cached copy without re-fetching, including offline.
- **FR-004**: The system MUST provide a command to refresh (re-fetch) remote references, updating the cache to the latest commit for a mutable ref; `hammerkit clean --cache` MUST also purge cached remote references.
- **FR-005**: A remote file's own relative `references`/`includes` and paths MUST resolve within that repo at that commit.
- **FR-006**: Resolution MUST NOT execute any task or command.
- **FR-007**: Credentials for private repos MUST reuse standard git mechanisms (credential helpers) — no new secret surface.
- **FR-008**: A commit-SHA ref MUST pin exact content (reproducible across machines); a branch/tag ref is frozen only in the per-machine cache.
- **FR-009**: Resolution errors MUST clearly name the repo, ref, and failure cause.
- **FR-010**: There MUST be no HTTP transport and no lockfile (ADR-0004).

### Key Entities

- **Remote reference**: a git repo, a ref (branch / tag / commit SHA), and an optional subpath.
- **Reference cache**: the local store of fetched repos at their resolved ref; the pin, refreshed by command or purged by `clean --cache`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A build file referencing a git best-practice file runs that file's task successfully.
- **SC-002**: After one online resolution, the same build resolves and runs offline from cache with identical content.
- **SC-003**: The refresh command updates a mutable-ref reference to the latest upstream commit; `clean --cache` forces a re-fetch.
- **SC-004**: A SHA-pinned reference yields identical content on two machines regardless of cache state.
- **SC-005**: A build file using only local `references`/`includes` behaves identically to the prior version.

## Assumptions

- Best-practice build files define tasks/services/caches/env (the kind of content in `best-practices/`), not the consumer's local `src` globs.
- Cross-machine reproducibility of the included file is **not** guaranteed for mutable refs; a commit SHA is the documented opt-in (ADR-0004).
- **Naming (open)**: the refresh command's verb collides with `cache pull` (ADR-0001, which syncs cache *artifacts*). Proposed `hammerkit includes pull` to disambiguate; final name TBD.
- Integration tests exercise a real git repo per the "real integrations over mocks" heuristic.
- This feature is opt-in: a project incurs remote-resolution behavior only when it declares a git source.
