---
description: The vocabulary you meet all at once when you start with hammerkit.
---

# Concepts

Hammerkit introduces a handful of terms that are easy to mix up at first. This page
defines each one in a line or two and links to the page that covers it in depth.
The example below uses most of them together.

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '22'

tasks:
  install:
    image: node:$NODE_VERSION-alpine   # has an image -> runs in a container
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm ci

  test:
    image: node:$NODE_VERSION-alpine
    deps: [install]      # another task must run first
    needs: [postgres]    # a service must be running first
    src:
      - src
    cmds:
      - npm test

services:
  postgres:
    image: postgres:16-alpine
    healthcheck:
      cmd: "pg_isready -U postgres"
    ports:
      - 5432
```
{% endcode %}

## Task vs. service

* A **[task](task/README.md)** is a piece of work that runs and finishes — compile,
  test, lint, deploy.
* A **[service](service/README.md)** is a long-running process a task depends on —
  a database, a message broker, an API. Hammerkit starts services when a task
  `needs` them and stops them when nothing needs them anymore.

## Local vs. container

The single rule: **an `image` means the task runs in a container; no `image` means
it runs on your host.** Container tasks get their tools from the image (recommended
— nothing to install locally, identical everywhere); local tasks use the tools
installed on the machine. See [run a task in a container](task/container.md).

## `src`, `generates`, `mounts`

* **`src`** — the input files/folders a task reads. They drive
  [caching](task/caching.md): unchanged `src` lets a task be skipped.
* **`generates`** — the output files/folders a task produces. These are what gets
  cached, [stored and restored](cli/store-restore.md).
* **`mounts`** — extra paths a *container* task needs that aren't sources or
  outputs (config files, caches). See [container](task/container.md#adding-mounts).

## `deps` vs. `needs`

* **`deps`** — task → task. The dependency tasks run (or are restored from cache)
  first. See [dependencies](task/dependencies.md).
* **`needs`** — task → service. The needed services are started and become healthy
  before the task runs. See [needs](task/needs.md).

## `references` vs. `includes` vs. `extend`

All three pull in definitions from other build files, but differently:

* **[`references`](build-file/references.md)** — point at another build file; its
  tasks are usable as `prefix:taskName`, keeping *their own* directory as the
  working directory.
* **[`includes`](build-file/includes.md)** — like references, but the included
  tasks adopt the *including* file's working directory. Ideal for reusable task
  templates across a monorepo.
* **[`extend`](task/extending.md)** — a per-task field that uses another task as a
  base template and overrides only what differs.

## Cache vs. store/restore

* **[Caching](task/caching.md)** is automatic: hammerkit skips a task whose `src`
  is unchanged, and with a cache **backend** it can share results across machines.
* **[`store` / `restore`](cli/store-restore.md)** are explicit commands that move
  generated outputs and cache state in and out of a directory — typically wired
  into a CI provider's own cache step.

These overlap; the [CI caching guide](guides/ci-caching.md) explains which to reach
for.
