---
description: >- 
    A task can declare needs on services.
    Hammerkit starts the services and waits until they are ready before the task runs.
---

# Needs

`needs` connect a task to the [services](../service/README.md) it depends on — a
database, a queue, an API. When you run a task, hammerkit starts every service it
needs, waits until each is ready, runs the task, and stops the services again once
nothing else needs them.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    healthcheck:
      cmd: "pg_isready -U postgres"
    ports:
      - 5432

tasks:
  api:
    description: "start api"
    image: node:22-alpine
    needs: [postgres]
    cmds:
      - node index.js
```

## Readiness

If a service defines a [`healthcheck`](../service/container.md#healthcheck),
hammerkit runs that command inside the service container and only starts the
dependent task once it exits `0`. The check is polled about once a second until it
passes; there are no `interval`/`timeout`/`retries` knobs — `cmd` is the only
field. A check that never passes simply keeps the dependent task waiting until you
cancel the run, so make the command something that genuinely reports readiness
(like `pg_isready`).

Without a healthcheck the task may start the moment the container starts, before
the service inside it is actually accepting connections.

## Connecting to the service

How a task reaches its service depends on whether the task runs in a container:

* **Container task** (has an `image`): it shares a network with the service and
  reaches it by the **service name** as the hostname, on the service's **container
  port**. For the example above, connect to `postgres:5432`.
* **Local task** (no `image`): it isn't on that network, so hammerkit injects the
  connection details as environment variables instead —
  `HAMMERKIT_POSTGRES_HOST` and `HAMMERKIT_POSTGRES_PORT`. See
  [environment hints for local tasks](../service/README.md#environment-hints-for-local-tasks).

A robust pattern that works for both is to keep the connection in a shared
top-level `envs` block and reference it from the service and the task:

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  POSTGRES_USER: api
  POSTGRES_DB: api
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
  migrate:
    image: node:22-alpine
    needs: [postgres]
    envs:
      DATABASE_URL: $DATABASE_URL
    cmds:
      - node migrate.js
```
{% endcode %}

## Naming a need

A bare `needs: [postgres]` uses the service under its own name. To depend on a
service under a different local alias — handy when a referenced/included file
exposes it under a prefix — use the object form:

```yaml
tasks:
  api:
    image: node:22-alpine
    needs:
      - service: db:postgres   # the service to depend on
        name: postgres         # the hostname/alias the task uses
    cmds:
      - node index.js
```

See [services](../service/README.md) for defining services, lifecycle and the
[connection-string details](../service/README.md#environment-hints-for-local-tasks).
