---
description: >-
  Caches describe how a task decides if it can be skipped and where its results
  are stored. With pluggable backends the cache can be shared across machines and
  CI runs.
---

# Caches

A cache combines two things: a **method** that decides if a task changed and a
**backend** that stores the task result so it can be reused later.

By default hammerkit keeps cache state locally per project. Since `1.6.0` you can
declare named caches with a remote **backend** (for example an S3 bucket) so a
task built on one machine can be restored on another - ideal for sharing results
between developers and CI runs.

## Declaring caches

Caches are declared in a top-level `caches:` block. Each entry has a `method` and
a `backend`.

{% code title=".hammerkit.yaml" %}
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
    src:
      - src
    generates:
      - dist
    cmds:
      - tsc -b
```
{% endcode %}

See [task caching](../task/caching.md) for how a task references a cache.

## Method

The method decides whether the source files of a task changed since the last run.

* `checksum` (default) - compares the content checksum of the source files.
* `modify-date` - compares the last modification date of the source files. Faster
  on large folders, but less precise.
* `none` - never skips the task, the commands run every time.

## Backends

The backend decides where task results are stored. Three backend types are built
in. Hammerkit pulls from the backend when the result is missing locally and pushes
to it after a task ran successfully.

### local

Stores cache entries on the local filesystem. Useful to share a cache between
projects on the same machine.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  shared:
    method: checksum
    backend:
      type: local
      path: /shared/hammerkit-cache
```
{% endcode %}

| Field  | Required | Description                                                        |
|--------|----------|--------------------------------------------------------------------|
| `path` | no       | Directory for the cache. Defaults to `~/.hammerkit/remote-cache`.  |

### s3

Stores cache entries in an S3-compatible bucket. Works with AWS S3 and any
S3-compatible service such as MinIO, Cloudflare R2 or Wasabi.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  remote:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: eu-central-1
      endpoint: https://minio.example.com   # for S3-compatible services
      prefix: hammerkit
```
{% endcode %}

| Field            | Required | Description                                                                          |
|------------------|----------|--------------------------------------------------------------------------------------|
| `bucket`         | yes      | Name of the bucket cache entries are written to.                                     |
| `region`         | no       | Region of the bucket.                                                                |
| `endpoint`       | no       | Custom endpoint for S3-compatible services (MinIO, R2, ...).                          |
| `prefix`         | no       | Key prefix for all cache entries, useful to share a bucket with other data.          |
| `forcePathStyle` | no       | Use path-style bucket addressing. Defaults to `true` when an `endpoint` is set.      |

{% hint style="info" %}
Credentials are read from the standard AWS SDK credential chain, for example the
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables or the
shared `~/.aws/config` file. They are never stored in the build file.
{% endhint %}

### noop

Does not store anything remotely and only keeps the local state. This is the
behavior of the built-in `default` cache.

```yaml
caches:
  local-only:
    method: checksum
    backend:
      type: noop
```

## Built-in caches

Two caches are always available without declaring them:

* `default` - uses the `noop` backend with the `checksum` method. This is what a
  task uses when it does not specify a cache.
* `none` - uses the `none` method, disabling skipping entirely.

## Pull / push behavior

When a cache has a remote backend (`local` or `s3`):

* **Pull** - before a task runs, if its result is not present locally, hammerkit
  pulls it from the backend and skips the task if the sources are unchanged.
* **Push** - after a task ran successfully, hammerkit pushes the result to the
  backend so other machines can reuse it.

{% hint style="warning" %}
Backend errors never fail the build. If the backend is unreachable, the pull or
push is skipped with a warning and the task runs or completes as usual.
{% endhint %}
