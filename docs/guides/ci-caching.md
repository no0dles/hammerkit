---
description: Reuse build results across CI runs — backends vs. store/restore.
---

# Caching strategy in CI

Locally, hammerkit caches automatically: a task whose `src` is unchanged is
skipped. The challenge in CI is that each run usually starts from a **fresh
checkout** on a **fresh machine**, so there is no local cache to hit. This guide
covers the two ways to carry results across CI runs and which to choose.

{% hint style="warning" %}
Keep the cache method at the default **`checksum`** in CI. `modify-date` compares
file timestamps, which `git clone` resets on every run — so a `modify-date` task
never hits the cache on a fresh runner. See [caching](../task/caching.md#checksum-vs-modify-date).
{% endhint %}

## Option A — a remote cache backend (recommended)

Point the built-in `default` cache at an S3-compatible bucket. Hammerkit then
**pulls** a task's result before running it and **pushes** the result after — no
cache scripting in your pipeline at all.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  default:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: eu-central-1

tasks:
  build:
    image: node:22-alpine
    src:
      - src
    generates:
      - dist
    cmds:
      - npm run build
```
{% endcode %}

Credentials come from the standard AWS SDK chain (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`), so set those as CI secrets. Backend errors never fail the
build — an unreachable bucket just falls back to running the task. The same bucket
works for developers locally, so a result built on a laptop is reused in CI and
vice versa. See [caches](../build-file/caches.md) for the full backend reference
(MinIO, R2, GCS).

## Option B — store / restore with the CI's own cache

If you'd rather use your CI provider's built-in caching, wrap the run with
[`store` / `restore`](../cli/store-restore.md): `restore` pulls the previous
results out of a directory before the build, `store` writes them back after, and
the CI caches that directory.

```bash
hammerkit restore cache   # before the build
hammerkit build
hammerkit store cache      # after the build
```

A GitHub Actions job wiring that to `actions/cache`:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm i -g hammerkit
      - uses: actions/cache@v4
        with:
          path: cache
          key: hammerkit-${{ hashFiles('**/package-lock.json') }}
          restore-keys: hammerkit-
      - run: hammerkit restore cache
      - run: hammerkit build
      - run: hammerkit store cache
```

## Which one?

| | Remote backend | store / restore |
|---|---|---|
| Pipeline wiring | None — automatic pull/push | You add `restore`/`store` steps + a cache step |
| Granularity | Per task | One directory for the whole run |
| Shared with local dev | Yes (same bucket) | No (CI cache only) |
| Needs object storage | Yes | No |

A remote backend is the lower-maintenance choice and is shared with local
development. If you already rely on your CI's cache and don't want a bucket,
store/restore is fine. You rarely need both — **if a remote backend is configured,
store/restore is redundant.**
