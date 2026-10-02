---
description: >-
  Caches describe how a task decides if it can be skipped and where its results
  are stored. With pluggable backends the cache can be shared across machines and
  CI runs.
---

# Caches

A cache combines two things: a **method** that decides if a task changed and a
**backend** that stores the task result so it can be reused later.

By default hammerkit caches task results on the local filesystem under
`~/.hammerkit/remote-cache`, so a result built in one checkout can be reused in
another on the same machine. Since `1.6.0` you can also declare named caches with
a remote **backend** (for example an S3 bucket or a container registry) so a task built on one machine can
be restored on another - ideal for sharing results between developers and CI runs.

## Which caching mechanism?

Hammerkit has three related features that all "save work". Pick by where the result
needs to go:

| Mechanism | What it does | Reach for it when |
|---|---|---|
| **Cache method** (`checksum`/`modify-date`) | Decides whether a task can be **skipped** locally. | Always on — it's how a task knows it's up to date. |
| **Cache backend** (`local`/`s3`/`registry`, this page) | **Shares** the skip-or-restore result across machines automatically. | Developers and CI should reuse each other's results without scripting. |
| **[`export: true`](../task/README.md#exporting-generated-files)** | Copies a container task's output **back into your workspace**. | Another tool outside hammerkit needs the produced files. |
| **[`store` / `restore`](../cli/store-restore.md)** | Manually moves outputs + cache state to a directory. | Wiring hammerkit into a CI provider's own cache step (no remote backend). |

A remote **backend** and **store/restore** solve the same "share across CI runs"
problem two ways: with a backend, pull/push is automatic and you don't script the
cache step; with store/restore, you hand the directory to your CI's cache. If a
remote backend is configured, you usually don't need store/restore at all. See the
[CI caching guide](../guides/ci-caching.md).

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
* `none` - never skips the task; the commands run every time.

## Backends

The backend decides where task results are stored. Three backend types are built
in. Hammerkit pulls from the backend when the result is missing locally and pushes
to it after a task ran successfully.

### local

Stores cache entries on the local filesystem. Useful to share a cache between
projects on the same machine. This is the backend used by the built-in `default`
cache.

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
S3-compatible service such as MinIO, Cloudflare R2, Google Cloud Storage or Wasabi.

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

#### Cloudflare R2

R2 exposes an S3 API, so point `endpoint` at your account endpoint and use an `auto`
region:

```yaml
caches:
  remote:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: auto
      endpoint: https://<account-id>.r2.cloudflarestorage.com
```

#### Google Cloud Storage (GCS)

GCS offers an S3-compatible XML API, so it works through the `s3` backend. Point
`endpoint` at `storage.googleapis.com`, use path-style addressing, and provide
[HMAC interoperability keys](https://cloud.google.com/storage/docs/authentication/hmackeys)
through the AWS credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`):

```yaml
caches:
  remote:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: europe-west1
      endpoint: https://storage.googleapis.com
      forcePathStyle: true
```

{% hint style="info" %}
Azure Blob Storage is **not** S3-compatible, so it is not supported through the `s3`
backend. The backend registry is pluggable, so an Azure backend could be added as a
custom backend in the future.
{% endhint %}

### registry

Stores cache entries in any OCI container registry — GHCR, Docker Hub, ECR, GAR,
Artifactory, Harbor or a plain `registry:2`. No bucket to provision: use the
registry you already push images to. Each entry is stored as a small single-layer
image tagged `<task-id>-<state-key>`.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  remote:
    method: checksum
    backend:
      type: registry
      repository: ghcr.io/my-org/hammerkit-cache
```
{% endcode %}

| Field        | Required | Description                                                                  |
|--------------|----------|------------------------------------------------------------------------------|
| `repository` | yes      | Repository to store entries in, without a tag (e.g. `ghcr.io/org/cache`).    |
| `insecure`   | no       | Use plain http. Defaults to `true` only for `localhost` / `127.0.0.1`.       |

{% hint style="info" %}
Credentials come from the docker config that `docker login` (or a CI login step
such as `docker/login-action`) writes, including credential helpers
(`credHelpers` / `credsStore`). `DOCKER_CONFIG` is honored. They are never
stored in the build file. A read-only token is enough for runners that only pull.
{% endhint %}

Removing entries (`hammerkit clean --cache`) requires the registry to allow
manifest deletion; retention is otherwise best left to the registry's own
cleanup policies.

## Retention

Caches grow with every new version of every task. A `retention` block bounds a
cache:

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  default:
    method: checksum
    backend:
      type: local
    retention:
      maxAge: 30d        # remove entries not used for 30 days
      maxSize: 20Gi      # then remove least recently used entries above 20Gi
      keepPerTask: 3     # keep at most the 3 newest versions of each task
```
{% endcode %}

| Field         | Description                                                                                  |
|---------------|----------------------------------------------------------------------------------------------|
| `maxAge`      | Remove entries not used within this long (`30s`, `5m`, `12h`, `30d`, …).                     |
| `maxSize`     | Remove least recently used entries until the cache is at most this big (`500Mi`, `5Gi`, `2G`). |
| `keepPerTask` | Keep only the newest N versions (state keys) of each task.                                   |

Policies apply in that order: `keepPerTask`, then `maxAge`, then `maxSize`.
Removing an entry never produces a wrong result — the task just rebuilds next time.

A **local** cache with `retention` is pruned automatically after every successful
run. Remote caches are only pruned when you ask for it:

```bash
hammerkit cache ls --remote shared                  # what's in it
hammerkit cache prune --remote shared --dry-run     # what the policy would remove
hammerkit cache prune --remote shared --max-age 14d # prune, overriding the policy
```

See [cache ls / prune](../cli/cache.md#cache-ls-and-cache-prune). The local backend
records when each entry was last used, so `maxAge` and `maxSize` evict what hasn't
been used recently. S3 and registries only know when an entry was created, so
there they evict by age of creation. Registries must allow deleting manifests
(`registry:2`, Harbor, ECR, GAR); for GHCR and Docker Hub use the registry's own
retention settings instead — for GHCR, for example, the
[`actions/delete-package-versions`](https://github.com/actions/delete-package-versions)
action. S3 lifecycle rules work alongside `cache prune` too.

## Built-in caches

Two caches are always available without declaring them:

* `default` - uses the `local` backend with the `checksum` method. This is what a
  task uses when it does not specify a cache, so results are cached under
  `~/.hammerkit/remote-cache` by default.
* `none` - uses the `none` method, disabling skipping entirely.

### Changing the default for all tasks

Declaring a `caches.default` entry overrides the built-in `default` cache, so the
new backend applies to **every task that does not reference a cache explicitly**.
This is the way to point all tasks at a shared local path or a remote bucket
without touching each task.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  default:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: eu-central-1
```
{% endcode %}

{% hint style="info" %}
The `--cache` flag still overrides the *method* for these implicit tasks at
runtime (it defaults to `checksum`), so redeclaring `caches.default` is primarily
how you change the default *backend*. See
[task caching](../task/caching.md#changing-the-default-for-all-tasks).
{% endhint %}

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
