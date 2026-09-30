# Changelog 1.7.0

A detailed summary about the release and the reasons behind the changes can be found
in the [release blog](../release-blog/release-1.7.0.md). For the recommended setup,
see [agents, workspaces and CI](../guides/agents-and-ci.md).

## Upgrade notes
- **One full rebuild after upgrading.** Cache keys are now computed from
  project-relative paths (see below), so every existing cache entry misses once.
- **Tasks without `src` always run.** A task with no `src` — and every task depending
  on one — runs on every invocation, as documented. Earlier versions cached such a
  task after its first run.
- **Dependencies of cached tasks are skipped.** A task pulled into a run only as a
  dependency no longer runs when every task depending on it is a cache hit, so its
  outputs (e.g. an exported `dist`) aren't produced. Request the task explicitly or
  pass `--no-skip-deps` to run the whole graph as before.
- **Explicit `cache pull`/`push` fail on backend errors.** The `s3` backend now
  distinguishes a missing entry from a transport or credential error. Builds are
  unaffected: they still treat a backend error as a cache miss with a warning.

## Added
- `registry` cache backend: store cache entries in any OCI registry (GHCR, Docker Hub,
  ECR, GAR, Artifactory, `registry:2`) using your existing `docker login` credentials,
  including credential helpers. See [caches](../build-file/caches.md#registry).
- `hammerkit cache pull` / `cache push --remote <name>`: move the current commit's
  cache entries between the local cache and a remote cache without running tasks —
  warm a workspace before building, publish results after. See
  [cache pull / push](../cli/cache.md).
- Read-only cache mode: `--cache-read-only` on `run`/`up`, or
  `HAMMERKIT_CACHE_READ_ONLY=1`, restores from cache backends but never writes to
  them; `cache push` refuses to run.
- Cache retention: a `retention` block on caches (`maxAge`, `maxSize`,
  `keepPerTask`), `hammerkit cache ls` and `hammerkit cache prune` (with `--dry-run`).
  Local caches with a policy are pruned automatically after every successful run;
  remote caches only with `--remote`. See [retention](../build-file/caches.md#retention).
- Skipping dependencies of cached tasks, with `--no-skip-deps` to opt out. See
  [dependencies of cached tasks](../task/dependencies.md#dependencies-of-cached-tasks).
- Task timeouts: `timeout` on a task and `--timeout` as a default on `run`/`up`. A
  timed-out task fails, is cleaned up and writes no cache entry. See
  [timeouts](../task/README.md#timeouts).
- `hammerkit explain [task]` (with `--json`) reports whether each task is a cache hit
  or miss and which input caused a miss; `run --explain` prints the cause inline. See
  [explain](../cli/explain.md).
- `run --dry-run` prints the execution plan with predicted cache hits and misses.
- End-of-run build summary with the cache hit ratio (`--no-summary`,
  `--summary-json`).
- `hammerkit graph [task]` prints the build graph as mermaid or dot. See
  [graph](../cli/graph.md).

## Changed
- **Cache keys no longer depend on where the project is checked out.** Paths in a
  task's or service's cache identity are relative to the project root (the git root,
  or the main build file's directory), so a laptop, a CI runner and an agent sandbox
  share cache entries. Machine-local runtime state (Docker containers, staging
  directory) stays scoped per checkout, so worktrees on one machine never share
  running containers. See [ADR-0006](../adr/0006-portable-cache-identity.md).
- The built-in `default` cache is now actually shared between checkouts on the same
  machine, as documented.
- A service is only started when a task that needs it actually runs; cache hits
  don't start their services.

## Fixed
- Tasks running on Kubernetes now wait for their job to finish and fail when it
  fails. Previously a task was reported as completed as soon as its job was created.
  Cancelling a run (or a timeout) now deletes the running job.
- Restoring a **container task** from a cache backend or `store`/`restore` now writes
  the outputs into the task's volumes. Previously they were written into a throwaway
  container and lost, so the task reported a cache hit with empty outputs.
- A task that needs a service no longer fails the run when it is a cache hit.
- A needed service that fails to start (missing image, port already in use) now
  fails the run immediately instead of hanging forever; service errors and crashes
  count as run failures.
- `cache push` uploads outputs that are current in the checkout even when they were
  never stored in the local cache.
- `build.schema.json` is regenerated and matches the build-file schema again
  (`continuous`, service `ports`, `registry` backend).
