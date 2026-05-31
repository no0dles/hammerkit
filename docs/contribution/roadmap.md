# Future Roadmap
The following topics are planned to be addressed in the future.

## Distributed computing
Offload complex and compute intensive tasks to remote hardware.
The goal will be to use the power of cloud computing, with very little configuration.

## Secret managers
Source environment variables from external secret managers (Vault, AWS/GCP, 1Password, …)
instead of plain `.env` files, and redact secret values from log output.
The goal will be a pluggable secret-provider mechanism (starting with a `command` provider)
referenced inline via `secret://<provider>/<name>`. Planned for 1.7.0 — see the
[detailed plan](secret-managers.md).

# Past topics on the roadmap

## Distributed caching
Distribute the local cache, so other developers and the CI can reuse already built
results. The goal was general performance improvements on CI and local development.

{% hint style="success" %}
Shipped in 1.6.0 as [pluggable cache backends](../build-file/caches.md): declare a
`local` or `s3` cache backend and hammerkit pulls/pushes task results automatically,
sharing them between developers and CI runs.
{% endhint %}

## Services
Task sometimes require some service to run.
For example a database, which is required to run an api or an integration test.
The goal will be to define those and hammerkit spins them up for the task and shuts them down if not needed.

{% hint style="success" %}
Services have been implemented with [container services](../service/container.md) and [kubernetes services](../service/kubernetes.md) in 1.5.0.
{% endhint %}

## Platform requirements
Define tasks that require a specific platform for local tasks.
The goal will be to either skip local tasks where platform requirements are not met or execute them on a remote machine.

{% hint style="success" %}
Labels have been implemented since 1.5.0 and can be used to archive this requirement/goal.
{% endhint %}

