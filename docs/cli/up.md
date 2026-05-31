---
description: Start the services of your build file and keep them running.
---

# Up

Services normally start and stop automatically based on the `needs` of the tasks
you run. The `up` command starts them directly, which is useful to keep shared
services such as a database running across several task runs during development.

```bash
hammerkit up
```

This starts every service in the build file (or the ones matching the
`--filter`/`--exclude` labels) and waits until you stop it. Use `--daemon` to
start the services in the background and return immediately.

```bash
hammerkit up --daemon
```

Stop services started this way with [`hammerkit down`](down.md).

{% hint style="info" %}
Pass `--env <name>` to start the services in a configured environment, for
example a Kubernetes cluster declared under `environments:`. See
[running on Kubernetes](../task/kubernetes.md).
{% endhint %}

## Options

```
Options:
  -f, --filter <labels...>    filter task and services with labels
  -e, --exclude <labels...>   exclude task and services with labels
  -c, --concurrency <number>  parallel worker count (default: 4)
  -w, --watch                 watch tasks (default: false)
  -d, --daemon                run services in background (default: false)
  --env <name>                environment
  -l, --log <mode>            log mode (choices: "interactive", "live", "grouped")
  --cache <method>            caching method to compare (choices: "checksum", "modify-date", "none")
  -h, --help                  display help for command
```
