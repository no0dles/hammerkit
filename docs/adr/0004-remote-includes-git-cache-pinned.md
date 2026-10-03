# 0004: Remote includes: git-only, mutable refs, cache-pinned, no lockfile

Remote `references`/`includes` resolve a build file from a **git repository only** (no HTTP transport). A reference may use a **mutable** ref (branch or tag) or an immutable **commit SHA**. There is **no lockfile**: the first resolution fetches the repo at the ref and caches it locally, and subsequent runs use the cached copy (so a machine is stable run-to-run, including offline). The cache — not a lockfile or an in-manifest SHA — is the pin. A dedicated **refresh/pull command** (and `hammerkit clean --cache`) re-fetches the latest for mutable refs. A commit SHA is the opt-in for full reproducibility.

## Considered options

- **HTTP transport** — rejected: no natural immutable identity, and git's clone-at-commit makes a remote file's own relative `references`/`includes` resolve trivially within the repo tree.
- **Committed lockfile** — rejected for simplicity; the user prefers a cache-as-pin model refreshed by command.
- **Reject mutable refs / SHA-only** — rejected in favor of the clean-to-update / pull-to-refresh ergonomics; SHA remains available as the reproducible opt-in.

## Consequences

- **Deliberate trade-off**: for a *mutable* ref, the pin is per-machine (the local cache). Nothing shared records which commit each machine froze, so a fresh CI runner pulls current branch HEAD while a developer's cache holds an older copy — the *build definition itself* can drift across machines with no record to detect it. This is accepted for distributing org best-practices; a commit SHA is the documented way to get cross-machine reproducibility.
- A remote file's relative `references`/`includes` and paths resolve within the same repo at the same commit.
- Credentials reuse standard git credential helpers — no new secret surface.
- Resolution executes nothing; a remote file contributes task/service/cache/env definitions only, and commands run only when a task is invoked.
- **Naming (settled, #20)**: the refresh command is `hammerkit includes pull`. Its verb would collide with `cache pull` (ADR-0001, which syncs cache *artifacts*), so it is namespaced under the `includes` command group to disambiguate the two operations.
- **Syntax (settled, #20)**: a `references`/`includes` value is a string-or-object discriminated union. A **string** is a local path (unchanged). An **object** `{ git, ref?, path? }` is a git source — `git` (repo URL) required, `ref` (branch/tag/commit SHA, default repo HEAD) and `path` (subpath) optional. The value's type selects the resolver, so the local-path form is unchanged.
