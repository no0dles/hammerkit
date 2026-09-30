# Roadmap

The topics below are planned for upcoming releases, roughly in priority order. Each
one has a specification in the repository's
[`specs/`](https://github.com/no0dles/hammerkit/tree/master/specs) folder; the
order may change as real-world feedback comes in.

## Next

### Secrets
First-class secrets for tasks and services — injected at runtime from the host
environment, a file or a secret manager, never stored in the build file and redacted
from logs. By default a secret doesn't affect the cache; a secret that determines
the output can opt in. See the [detailed plan](secret-managers.md).

### Container runtime options
Declare Docker runtime and security options such as `--shm-size` or a seccomp
profile on container tasks and services, for workloads like browsers or sandboxed
workers that need them.

## Later

* **Task resources** — CPU and memory requests/limits per task, enforced on Docker
  and Kubernetes and used for resource-aware local scheduling instead of a flat
  worker count.
* **Matrix tasks** — define a task once with a `matrix` of variants (Node versions,
  architectures) and run one independently cached task per combination.
* **Remote includes** — reference or include build files from a git repository, so
  shared templates like the [recipes](../recipes.md) can be reused across projects.
* **Service state snapshots** — cache the state a task leaves *inside* a service,
  such as a seeded database, so it can be restored instead of recreated.
* **Multi-arch packaging** — let `hammerkit package` build and push multi-platform
  images.
* **Distributed computing** — offload compute-intensive tasks to remote hardware
  with very little configuration.

# Shipped

## Agent-ready caching (1.7.0)
Make one shared cache work across coding-agent sandboxes, developer workspaces and
CI, so work done in one place is never repeated in another.

{% hint style="success" %}
Shipped in 1.7.0: cache keys independent of the checkout location, the `registry`
cache backend, [`cache pull` / `cache push`](../cli/cache.md), read-only mode,
[cache retention](../build-file/caches.md#retention), skipping
[dependencies of cached tasks](../task/dependencies.md#dependencies-of-cached-tasks),
[task timeouts](../task/README.md#timeouts), and [`explain`](../cli/explain.md),
[`graph`](../cli/graph.md), `run --dry-run` and the build summary. See the
[release blog](../release-blog/release-1.7.0.md) and
[agents, workspaces and CI](../guides/agents-and-ci.md).
{% endhint %}

## Distributed caching (1.6.0)
Distribute the local cache, so other developers and CI can reuse already built
results.

{% hint style="success" %}
Shipped in 1.6.0 as [pluggable cache backends](../build-file/caches.md): declare a
`local` or `s3` cache backend and hammerkit pulls and pushes task results
automatically, sharing them between developers and CI runs.
{% endhint %}

## Run on Kubernetes (1.6.0)
Run the same build file on the local Docker daemon or on a Kubernetes cluster.

{% hint style="success" %}
Shipped in 1.6.0 through [environments](../task/kubernetes.md).
{% endhint %}

## Services (1.5.0)
Tasks sometimes require a service to run, for example a database for an API or an
integration test. The goal was to define those services and have hammerkit start
them for a task and stop them when they are no longer needed.

{% hint style="success" %}
Implemented in 1.5.0 with [container services](../service/container.md) and
[Kubernetes services](../service/kubernetes.md).
{% endhint %}

## Platform requirements (1.5.0)
Define local tasks that require a specific platform. The goal was to either skip
local tasks where the platform requirements are not met or run them on a suitable
machine.

{% hint style="success" %}
Labels, available since 1.5.0, can be used to achieve this.
{% endhint %}
