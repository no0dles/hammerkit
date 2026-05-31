---
description: How tasks reach services — connection strings, ports and lifecycle.
---

# Services & networking

A [service](../service/README.md) is a long-running dependency — a database, a
queue, an API — that a task `needs`. This guide covers how a task actually connects
to one, and how services start and stop.

## Lifecycle

You don't start services by hand. When you run a task that `needs` a service,
hammerkit:

1. starts the service container,
2. waits for its [healthcheck](../service/container.md#healthcheck) to pass,
3. runs the task, and
4. stops the service once nothing else needs it.

For development you can keep services up across many task runs with
[`hammerkit up`](../cli/up.md) (and `--daemon` to background them), stopping them
later with [`hammerkit down`](../cli/down.md).

## Connecting: container task vs. local task

How a task reaches a service depends on whether it runs in a container:

* **Container task** (`image` set): shares a network with the service and reaches
  it by the **service name** as hostname, on the service's **container port**. You
  do **not** need to publish a `port` for this.
* **Local task** (no `image`): isn't on that network, so hammerkit injects
  `HAMMERKIT_<NAME>_HOST` and `HAMMERKIT_<NAME>_PORT` env vars instead.

The `HAMMERKIT_*` hints are **local-task only** — a container task won't get them,
because it doesn't need them (it uses the service name directly).

## A pattern that works for both

Put the connection string in a shared top-level `envs` block and reference it from
the task. For a container task, point it at the service name; the same value reads
naturally in your code:

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  DATABASE_URL: postgres://api@postgres:5432/api

services:
  postgres:
    image: postgres:16-alpine
    envs:
      POSTGRES_USER: api
      POSTGRES_DB: api
      POSTGRES_HOST_AUTH_METHOD: trust
    healthcheck:
      cmd: "pg_isready -U api"
    ports:
      - 5432

tasks:
  api:
    image: node:22-alpine
    needs: [postgres]
    envs:
      DATABASE_URL: $DATABASE_URL
    cmds:
      - node index.js
```
{% endcode %}

For a **local** `api` task (no `image`), build the URL from the injected hints in
your start script instead, e.g. `postgres://api@$HAMMERKIT_POSTGRES_HOST:$HAMMERKIT_POSTGRES_PORT/api`.

## Ports are for your host, not for tasks

`ports` publish a service to your **host** machine — handy for connecting a GUI
client or `psql` to a running database during development. Tasks share the
service's network and can reach every container port directly, so they don't need
`ports` at all.

## Readiness

Always give a service a `healthcheck` when a task depends on it being usable, not
just started. Hammerkit polls the `cmd` about once a second and only starts the
dependent task once it exits `0`; there are no `interval`/`retries` knobs, and a
check that never passes blocks the task until you cancel. See
[healthcheck timing](../service/container.md#timing-and-failure).

## Persisting data

A service container is recreated on each start, so its data is lost unless you
attach a [volume](../service/container.md#volumes). Use volumes to keep a database
between runs, and [`store` / `restore`](../cli/store-restore.md) to seed or back up
that data.

## Sharing and Kubernetes

Services can be [referenced/included](../build-file/includes.md) like tasks, so one
database definition is reused across projects. To forward a service from a real
cluster instead of running it locally, see
[Kubernetes services](../service/kubernetes.md).
