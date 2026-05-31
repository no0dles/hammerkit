# Changelog 1.5.0

A detailed summary about the release and the reasons behind the changes can be found
in the [release blog](../release-blog/release-1.5.0.md).

## Added
- Services: long-running dependencies a task can `need`. Hammerkit starts them, waits for an optional `healthcheck`, and stops them when no longer needed.
- Container services, run in the same network as container tasks with automatic DNS by service name.
- Kubernetes services, forwarding pods/services/deployments from a cluster into a task.
- Labels on tasks and build files, with `--filter`/`-f` and `--exclude`/`-e` to scope a command to a group of tasks/services.
- New `ls` command to list all tasks and services.

## Changed
- CLI start-up is faster: build files (including references/includes) are now parsed lazily, only when a task executes or `ls` runs, instead of on every invocation.
