# Changelog 1.6.0

A detailed summary about the release and the reasons behind the changes can be found
in the [release blog](../release-blog/release-1.6.0.md).

## Added
- Pluggable cache backends with automatic pull/push. A new top-level `caches:` block declares a cache with a `method` and a `backend` (`local`, `s3` or `noop`). Tasks reference a cache through the `cache` field.
- Run tasks and services on a Kubernetes cluster through a new `environments:` block, selected with the `--env` argument. Tasks run as jobs, container services as deployments.
- Store and restore now work against a Kubernetes environment via `--env`.
- Service healthchecks are translated into Kubernetes readiness and liveness probes.
- Exportable generated files via `generates: [{ path, export: true }]`, copying outputs back into the workspace.
- Services can declare `deps` and `needs`, support parallel usage and named references.
- New `up` and `down` commands to start and stop services directly.
- Local tasks receive connection details of needed services as environment variables (`HAMMERKIT_<NAME>_HOST`, `HAMMERKIT_<NAME>_PORT`, `HAMMERKIT_<NAME>_PORT_<containerPort>`).
- Optional `namespace` for Kubernetes services.

## Changed
- Introduced a runtime abstraction so the same build file runs on the local docker daemon or on Kubernetes.
- Kubernetes port-forwarding no longer requires the `kubectl` binary; ports are forwarded through the kubernetes client.
- Internal rename of the "node" concept to "task".

## Fixed
- Build graphs that mix `deps` and `needs` in a cycle are now detected instead of deadlocking.
- Local tasks use a pid file to prevent concurrent runs of the same task; stale pids are swept automatically.
- A crashing docker service is reported as a crash instead of terminating silently.
- Improved error handling when a configured cluster is missing.
- Various stability fixes for environment file replacement and Windows test runs.
