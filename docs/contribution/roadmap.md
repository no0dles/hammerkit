# Future Roadmap
The following topics are planned to be addressed in the future.

## Distributed computing
Offload complex and compute intensive tasks to remote hardware.
The goal is to use the power of cloud computing with very little configuration.

## Secret managers
Source environment variables from external secret managers (Vault, AWS/GCP, 1Password, …)
instead of plain `.env` files, and redact secret values from log output.
The goal is a pluggable secret-provider mechanism (starting with a `command` provider)
referenced inline via `secret://<provider>/<name>`. Planned for a release after 1.7.0 — see the
[detailed plan](secret-managers.md).

# Past topics on the roadmap

## Distributed caching
Distribute the local cache, so other developers and the CI can reuse already built
results. The goal was general performance improvements on CI and local development.

{% hint style="success" %}
Shipped in 1.6.0 as [pluggable cache backends](../build-file/caches.md): declare a
`local` or `s3` cache backend and hammerkit pulls/pushes task results automatically,
sharing them between developers and CI runs. 1.7.0 made cache keys independent of
the checkout location and added the `registry` backend and
[`cache pull` / `cache push`](../cli/cache.md) — see
[agents, workspaces and CI](../guides/agents-and-ci.md).
{% endhint %}

## Services
Tasks sometimes require a service to run, for example a database for an API or an integration test.
The goal was to define those services and have hammerkit start them for a task and stop them when they are no longer needed.

{% hint style="success" %}
Services have been implemented with [container services](../service/container.md) and [Kubernetes services](../service/kubernetes.md) in 1.5.0.
{% endhint %}

## Platform requirements
Define local tasks that require a specific platform.
The goal was to either skip local tasks where platform requirements are not met or execute them on a remote machine.

{% hint style="success" %}
Labels, available since 1.5.0, can be used to achieve this.
{% endhint %}

