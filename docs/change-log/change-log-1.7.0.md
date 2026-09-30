# Changelog 1.7.0

## Added
- `hammerkit explain [task]` (and `--json`) reports why a task is a cache hit or miss; `run --explain` prints the miss cause inline.
- `hammerkit graph [task]` serializes the build graph as mermaid or dot.
- End-of-run build summary with hit ratio (`--no-summary`, `--summary-json`).
- `--cache-read-only` (or `HAMMERKIT_CACHE_READ_ONLY=1`) on `run`/`up`: restore from cache backends but never push — for agent sandboxes and other untrusted runners.
- `run --dry-run` previews the execution plan with predicted cache hits/misses.

## Changed
- **Cache ids no longer depend on where the project is checked out.** Paths in the cache identity are relative to the project root (the git root, or the main build file's directory), so an agent sandbox, a CI runner and a laptop share cache entries through a remote backend. Machine-local runtime state (docker containers, staging directory) stays scoped per checkout. Every id changes once on upgrade, so expect one full rebuild. See [ADR-0006](../adr/0006-portable-cache-identity.md).
