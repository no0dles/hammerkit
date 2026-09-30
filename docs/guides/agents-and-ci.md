---
description: >-
  Share one cache between coding-agent sandboxes, developer workspaces and CI,
  so work done in one place is never repeated in another.
---

# Agents, workspaces and CI

Hammerkit's cache key is a hash of a task's inputs — command, image, sources and
dependencies — computed relative to the project root. The same commit therefore
produces the same keys in a coding agent's sandbox, on a CI runner and on a
laptop. Put those results in a shared remote cache and:

* **CI does not repeat what an agent already ran** — an agent that ran the e2e
  suite on a commit leaves the result behind; CI restores it and skips the job,
  including starting its database.
* **New workspaces start warm** — a fresh sandbox pulls the dependency install
  and build outputs instead of rebuilding them.
* **Less compute overall** — each unique input is built once, wherever it ran
  first.

## 1. Declare a remote cache

Any OCI registry works; use the one you already push images to. (An
[S3-compatible bucket](../build-file/caches.md#s3) works the same way.)

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  shared:
    method: checksum
    backend:
      type: registry
      repository: ghcr.io/my-org/hammerkit-cache

services:
  db:
    image: postgres:16-alpine
    envs:
      POSTGRES_PASSWORD: postgres
    ports:
      - :5432          # random host port: parallel workspaces never collide
    healthcheck:
      cmd: pg_isready -U postgres

tasks:
  install:
    image: node:24-alpine
    src: [package.json, package-lock.json]
    generates: [node_modules]
    cmds: [npm ci]

  build:
    image: node:24-alpine
    deps: [install]
    src: [src]
    generates: [dist]
    cmds: [npm run build]

  e2e:
    image: cypress/included:13.15.0
    deps: [build]
    needs: [db]
    src: [cypress]
    cmds: [cypress run]
```
{% endcode %}

Tasks keep caching to the machine-local `default` cache; the `shared` cache is
only touched by `cache pull` / `cache push`, so builds never wait on the network.

{% hint style="info" %}
Use **container tasks** for anything you want to share: a local task includes the
host OS in its cache key, so a macOS laptop and a Linux runner would not share it.
{% endhint %}

## 2. In the agent sandbox

Set up the workspace from the cache, work, then publish the results:

```bash
docker login ghcr.io                       # or mount a docker config with a token
hammerkit cache pull --remote shared       # warm workspace: deps + build restored
hammerkit run e2e                          # only what changed runs
hammerkit cache push e2e --remote shared   # leave the results for CI and others
```

## 3. In CI

```bash
hammerkit cache pull --remote shared
hammerkit run e2e                          # cache hits execute nothing
hammerkit cache push --remote shared       # publish anything CI had to build
```

A task whose inputs were already run by an agent completes as a cache hit in
milliseconds, and services it needs are not started.

## Who may write to the cache?

Pushing is trusting: a cache hit means "this exact input already produced this
result", and CI will not re-check it. Decide per runner:

| Policy | Agents | CI | Trade-off |
|---|---|---|---|
| **Agents write** (above) | `cache push` | reads, pushes misses | Maximum reuse; CI trusts results produced in sandboxes. |
| **CI writes only** | read-only token + `HAMMERKIT_CACHE_READ_ONLY=1` | reads + pushes | Agents still start warm; CI re-runs what agents ran. |
| **Split** | push to `agents` cache | pulls `agents` for PR checks, only pushes to `shared` on `main` | Agent results speed up PR feedback, never the release path. |

Enforce the policy with registry credentials (a pull-only token for read-only
runners); `HAMMERKIT_CACHE_READ_ONLY=1` makes hammerkit refuse pushes as well,
so a misconfigured runner fails loudly instead of writing.

## Checking why something rebuilt

```bash
hammerkit explain e2e          # hit or miss, and which input changed
hammerkit run --explain        # the miss cause next to every rebuilt task
hammerkit run --dry-run        # predicted hits/misses without running anything
```
