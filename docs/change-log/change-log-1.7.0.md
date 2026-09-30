# Changelog 1.7.0

## Added
- `registry` cache backend: store cache entries in any OCI registry (GHCR, Docker Hub, ECR, GAR, Artifactory, `registry:2`) using your existing `docker login` credentials — no bucket to provision.
- `hammerkit cache pull` / `cache push --remote <name>` move the current state's cache entries between the local cache and a remote cache without running tasks — warm a workspace before building, upload after a trusted build.
- `hammerkit explain [task]` (and `--json`) reports why a task is a cache hit or miss; `run --explain` prints the miss cause inline.
- `hammerkit graph [task]` serializes the build graph as mermaid or dot.
- End-of-run build summary with hit ratio (`--no-summary`, `--summary-json`).
- `--cache-read-only` (or `HAMMERKIT_CACHE_READ_ONLY=1`) on `run`/`up`: restore from cache backends but never push — for agent sandboxes and other untrusted runners.
- `run --dry-run` previews the execution plan with predicted cache hits/misses.

## Changed
- The `s3` backend now distinguishes a missing entry from a transport/credential error. Builds still degrade to a cache miss with a warning; explicit `cache pull`/`push` fail.
- **Cache ids no longer depend on where the project is checked out.** Paths in the cache identity are relative to the project root (the git root, or the main build file's directory), so an agent sandbox, a CI runner and a laptop share cache entries through a remote backend. Machine-local runtime state (docker containers, staging directory) stays scoped per checkout. Every id changes once on upgrade, so expect one full rebuild. See [ADR-0006](../adr/0006-portable-cache-identity.md).

## Fixed
- Restoring a **container task** from a cache backend or `store`/`restore` now writes the outputs into the task's volumes. Previously they were written into a throwaway container and lost, so the task reported a cache hit with empty outputs.
- A task that needs a service no longer fails the run when it is a cache hit; the service is not started at all.
- A needed service that fails to start (bad image, port already in use) now fails the run immediately instead of hanging forever.
- `cache push` uploads outputs that are current in the checkout even when they were never stored in the local cache.

See the new guide [Agents, workspaces and CI](../guides/agents-and-ci.md) for the recommended setup.
