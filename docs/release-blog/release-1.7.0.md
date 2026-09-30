# Release 1.7.0

A retrospective on 1.7.0. Release 1.6.0 made caches shareable through remote
backends; this release makes that sharing actually work across machines, and
makes it cheap. The goal: work done anywhere — on a laptop, in a coding agent's
sandbox or on a CI runner — is never repeated anywhere else.

## Cache keys no longer depend on where you check out

A task's cache key is a hash of its definition (commands, image, env, paths) and
its inputs. Until now the paths in that hash were absolute. The same commit
checked out at `/home/runner/work/app/app` on a CI runner and at `/workspace/app`
in a sandbox therefore produced *different* keys, and a shared remote cache never
hit between them.

In 1.7.0 every path in the key is relative to the **project root** — the git root,
or the directory of the main build file. The same commit now has the same keys on
every machine. Machine-local state (Docker containers, staging directories) stays
scoped to each checkout, so two worktrees on one machine share cached results but
never step on each other's running containers.

{% hint style="warning" %}
Every cache key changes once with this release, so the first run after upgrading
is a full rebuild.
{% endhint %}

## Use the registry you already have

The new `registry` backend stores cache entries in any OCI container registry —
GHCR, Docker Hub, ECR, GAR, Artifactory or a plain `registry:2`. There is no bucket
to provision: use the registry you already push images to, with the credentials
`docker login` already set up.

```yaml
caches:
  shared:
    method: checksum
    backend:
      type: registry
      repository: ghcr.io/my-org/hammerkit-cache
```

Each entry is a small single-layer image tagged `<task-id>-<state-key>`. It talks to
the registry directly (no Docker daemon or extra tools involved) and writes the
manifest last, so a half-finished upload is never visible to anyone else. See
[caches](../build-file/caches.md#registry).

## `cache pull` and `cache push`

With 1.6.0, a task whose cache was remote talked to the bucket during the build.
1.7.0 adds a second way that keeps the network out of the build entirely: tasks
cache to the machine-local default cache, and two commands move entries between
that and a remote cache, without running anything.

```bash
hammerkit cache pull --remote shared   # warm the workspace: network only
hammerkit run                          # build: compute only
hammerkit cache push --remote shared   # publish what was built
```

`cache pull` fetches exactly the entries the current commit will look up,
including all dependencies. That makes it the fastest way to set up a new
workspace. `cache push` publishes results even when they were never written to
the local cache. Both are safe to re-run. See [cache pull / push](../cli/cache.md).

## Don't rebuild what nothing needs

A cache hit used to save only the task itself. When CI pulled the result of an e2e
job, the e2e task was skipped — but the app build it depends on still ran, because
that build's own result wasn't on the machine. Nothing in the run used it.

Dependencies now run only when a task that needs them has to run. A task pulled into
the run purely as a dependency waits until something depending on it misses the
cache; if everything depending on it is a hit, it is **skipped** and shows up as
such in the build summary. The decision follows the real cache outcome rather than a
prediction, so a restore that fails still gets its dependencies built. Tasks you
name or select with labels always run, and `--no-skip-deps` restores the old
"run the whole graph" behavior. See
[dependencies of cached tasks](../task/dependencies.md#dependencies-of-cached-tasks).

## Keep shared caches small

Once every CI run and every workspace pushes to a shared cache, it grows without
bound. Caches can now declare a **retention** policy:

```yaml
caches:
  default:
    method: checksum
    backend:
      type: local
    retention:
      maxAge: 30d
      maxSize: 20Gi
      keepPerTask: 3
```

`hammerkit cache ls` shows what a cache holds, and `hammerkit cache prune` applies
the policy (or one given on the command line, with `--dry-run` to preview). A local
cache with a policy prunes itself after every successful run; remote caches are only
pruned when you name them with `--remote`. The local cache tracks when each entry
was last used, so what you still use stays. See
[retention](../build-file/caches.md#retention).

## Timeouts

A hanging test used to block a CI job until the provider killed it. Tasks can now
declare a `timeout` (and `--timeout` sets a default for all of them):

```yaml
tasks:
  e2e:
    image: cypress/included:13.15.0
    timeout: 15m
    cmds:
      - cypress run
```

A task that runs longer fails with `timed out after 15m`, its process, container or
Kubernetes job is cleaned up, and nothing is written to the cache. See
[timeouts](../task/README.md#timeouts).

## Agents, workspaces and CI share one cache

Put together, these change how CI and coding agents can work together. An agent
that ran the e2e suite on a commit in its sandbox pushes the result; CI pulls it and
the e2e job completes as a cache hit in milliseconds. The database it needs isn't
even started. A new workspace pulls the dependency install and the build instead
of redoing them, so only what actually changed runs.

We tried this on a small stand-in project (`npm install` → build → an e2e job
needing Postgres) across three simulated machines and a local registry:

| Scenario | Result |
|---|---|
| Agent sandbox, cold run + `cache push` | 3 tasks executed, 3 entries pushed |
| CI runner (other machine, other path) after `cache pull` | 0 executed, 100% cache hits, database not started |
| New agent workspace, `cache pull build` | install and build restored; only the edited e2e task ran |

Who may write to a shared cache is a policy decision: a cache hit means CI trusts
the result. The new **read-only mode** (`--cache-read-only` or
`HAMMERKIT_CACHE_READ_ONLY=1`) lets a runner restore from the cache while never
writing to it. That fits agent sandboxes you don't fully trust, or pull requests
from forks. The [agents, workspaces and CI guide](../guides/agents-and-ci.md)
walks through the setup and the trade-offs.

## See why something ran

Caching is only useful if you can tell why it didn't hit. 1.7.0 adds:

* **[`hammerkit explain`](../cli/explain.md)** — for each task, whether the next
  run is a cache hit and which input caused a miss: a changed source file, a
  changed dependency, a changed command or image. `--json` for tooling.
* **`run --explain`** — the miss cause printed inline for every task that rebuilds.
* **`run --dry-run`** — the execution plan in order, with predicted hits and misses,
  without running anything.
* **Build summary** — after every run, a line per task (executed or cached, and how
  long it took) plus the cache hit ratio; `--summary-json` for dashboards and
  agents.
* **[`hammerkit graph`](../cli/graph.md)** — the task and service graph as mermaid
  or dot.

## Fixes that mattered

Running the new setup end to end surfaced several bugs, all fixed in this release:

* **Container task outputs restored from a cache were lost.** They were written into
  a throwaway container instead of the task's volume, so the task reported a cache
  hit while its outputs were empty. This affected remote caches and
  `store`/`restore`.
* **A cached task that needs a service failed the run.** The service was left
  waiting and then cancelled. Now it isn't started at all.
* **A service that fails to start hung the run forever** (a missing image, a port
  already in use). The task waiting for it now fails right away.
* **Tasks without `src` were cached after one run.** As documented, a task without
  `src` — and everything depending on it — now always runs, since hammerkit can't
  prove it's up to date.
* **Tasks on Kubernetes didn't wait for their jobs.** A task running as a
  Kubernetes job was reported as completed as soon as the job was created, and a
  failing job was never detected. Tasks now wait for the job, fail when it fails,
  and delete it when the run is cancelled or times out.
* **S3 errors looked like cache misses.** An unreachable bucket or bad credentials
  are now reported as errors by `cache pull`/`push`; builds still degrade to a
  miss with a warning.

## Next release

Next up are first-class secrets for tasks and services, and container runtime
options such as `--shm-size` for browser-based tests. See the
[roadmap](../contribution/roadmap.md).
