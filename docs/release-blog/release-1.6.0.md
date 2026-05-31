# Release 1.6.0

A retro about the changes in 1.6.0. This release focuses on sharing work across
machines: caches can now live in a remote backend, and the same build file can run
on the local docker daemon or on a Kubernetes cluster.

## Remote caching with pluggable backends
Until now the cache state lived only on the machine that ran a task. With 1.6.0 a
cache can be backed by a remote **backend**, so a task built on one machine can be
restored on another - perfect for sharing results between developers and CI.

Caches are declared in a top-level `caches:` block with a method and a backend.
Two backends are built in: `local` (a shared filesystem directory, used by the
built-in `default` cache) and `s3` (AWS S3 and any S3-compatible service like
MinIO, R2 or Wasabi).

```yaml
caches:
  remote:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: eu-central-1

tasks:
  build:
    cache:
      name: remote
    src: [src]
    generates: [dist]
    cmds:
      - tsc -b
```

Hammerkit pulls a result from the backend before a task runs if it is missing
locally, and pushes it after a successful run. Backend errors never fail the build,
they only produce a warning. More details in [caches](../build-file/caches.md).

## Checksum is now the default everywhere

Until now the cache method defaulted to `modify-date` locally and only `checksum`
in CI. With remote backends that split no longer makes sense: a result is shared
between machines, and `modify-date` compares file modification times, which a
`git clone` resets on every fresh checkout — so a developer's `modify-date` result
would never line up with a CI runner's. The whole point of an S3 backend is to
reuse work *across* machines, and only `checksum` (which compares file content) is
stable across them.

So `checksum` is now the default in **all** environments. The same comparison runs
locally and in CI, so a result cached on one is correctly reused on the other.

{% hint style="warning" %}
This is a behavior change, almost a breaking one: if you relied on the local
`modify-date` default (for example to avoid hashing very large source folders), set
it explicitly with `cache: modify-date` on the task or `--cache modify-date` on the
command. See [caching](../task/caching.md#checksum-vs-modify-date).
{% endhint %}

## Run on Kubernetes
A new runtime abstraction lets the same build file run on the local docker daemon or
on a Kubernetes cluster. Declare an `environments:` block and select it with
`--env <name>`. Tasks run as jobs, container services run as deployments, and a
service healthcheck is turned into readiness and liveness probes.

```yaml
environments:
  default:
    kubernetes:
      context: docker-desktop
```

```bash
hammerkit api --env default
```

The store and restore commands accept `--env` too, so results can be stored from or
restored to a cluster. See [running on Kubernetes](../task/kubernetes.md).

## Service improvements
Services got more capable in this release:

- Services can declare `deps` and `needs`, just like tasks.
- Multiple services can run in parallel and be referenced across projects.
- The new `up` and `down` commands start and stop services directly.
- Local tasks receive the connection details of needed services as environment
  variables (`HAMMERKIT_<NAME>_HOST`, `HAMMERKIT_<NAME>_PORT`), since they are not
  part of the container network.

For [Kubernetes services](../service/kubernetes.md) the port-forwarding no longer
requires the `kubectl` binary, and a `namespace` can be set per service.

## Exporting build outputs
Generated files can be marked with `export: true` to copy them back into your
workspace after a task ran, so other tools can pick them up.

```yaml
tasks:
  build:
    image: node:alpine
    generates:
      - path: dist
        export: true
    cmds:
      - tsc -b
```

## Reliability
A few robustness improvements landed as well: build graphs that mix `deps` and
`needs` in a cycle are now detected instead of deadlocking, local tasks use a pid
file to prevent concurrent runs of the same task, and a crashing docker service is
reported as a crash instead of terminating silently.
