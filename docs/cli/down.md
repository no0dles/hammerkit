---
description: Stop services that were started with up.
---

# Down

Stops the services of your build file, for example the ones started with
[`hammerkit up`](up.md) or left running by `up --daemon`.

```bash
hammerkit down
```

Only the services matching the `--filter`/`--exclude` labels are stopped when
those options are given.

{% hint style="info" %}
Pass `--env <name>` to target the services of a configured environment, for
example a Kubernetes cluster declared under `environments:`.
{% endhint %}

## Options

```
Options:
  -f, --filter <labels...>   filter task and services with labels
  -e, --exclude <labels...>  exclude task and services with labels
  --env <name>               environment
  -h, --help                 display help for command
```
