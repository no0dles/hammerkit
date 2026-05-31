---
description: >-
    A service is a continuous task that does not end. 
    Something a task may require a service to perform.
---

# Service
Service can help task to perform their work.
For example a database for your application or an api to your integration test run.

Services can be defined to run in a container or forwarded from a kubernetes cluster. 
Each need of a task will be available in the container network by the name of the service.

Local tasks can also use needs, but hammerkit will not provide a dns resolution.
Instead, the connection details of each needed service are passed to the task as
environment variables (see [environment hints](#environment-hints-for-local-tasks)).

## Container
Similar to [container tasks](../task/container.md) need container services an image to run.
Tasks can declare the need for services and before the task gets executed, hammerkit will ensure the service is running.

[Healthchecks](./container.md#healthcheck) can be used, to ensure that the service is running and ready to be used.

```yaml
services:
  postgres:
    image: postgres
    envs:
      POSTGRES_USER: api
      POSTGRES_DB: api
      POSTGRES_PASSWORD: 123456
    healthcheck:
      cmd: "pg_isready -U postgres"
    ports:
      - 5432

tasks:
  api:
    image: node:alpine
    needs: [postgres]
    cmds:
      - node index.js
```


## Kubernetes
[Kubernetes services](./kubernetes.md) allow to use resources from local and remote kubernetes clusters.
This allows easy integration with development or staging environments resources and can be used to debug/troubleshoot your application with data from other environments.

```yaml
services:
  postgres-staging:
    context: staging
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres

tasks:
  api-staging:
    image: node:alpine
    needs: [postgres-staging]
    cmds:
      - node index.js
```

## Connecting from a container task
A container task shares a network with its needed services and reaches each one by
its **service name** as the hostname, on the service's **container port**. You
don't publish a port for this — `ports` are only needed to reach a service from
your host.

For the `postgres` service above (exposing `5432`), a container task connects with
a URL like `postgres://api@postgres:5432/api` — `postgres` is the service name and
`5432` the container port. Keep that string in a shared top-level `envs` block so
the service and the task agree on it:

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
  migrate:
    image: node:22-alpine
    needs: [postgres]
    envs:
      DATABASE_URL: $DATABASE_URL
    cmds:
      - node migrate.js
```
{% endcode %}

## Environment hints for local tasks
A local task (a task without an `image`) is not part of that container network, so
hammerkit instead injects the connection details as environment variables.

For every needed service the following variables are available, where `NAME` is the
uppercased service name:

* `HAMMERKIT_<NAME>_HOST` - host the service is reachable on.
* `HAMMERKIT_<NAME>_PORT` - the primary published port.
* `HAMMERKIT_<NAME>_PORT_<containerPort>` - the published port for a specific
  container port. The suffix is always the numeric container port (ports cannot be
  named), so this is mainly useful for services that expose more than one port.

For a service named `postgres` exposing port `5432` a local task receives
`HAMMERKIT_POSTGRES_HOST`, `HAMMERKIT_POSTGRES_PORT` and `HAMMERKIT_POSTGRES_PORT_5432`.

## Service dependencies
Like tasks, services can declare `deps` and `needs`. Use `deps` when a service
requires a task to run first (for example building an image input), and `needs`
when a service depends on another service.

```yaml
services:
  api:
    image: node:alpine
    deps: [install]
    needs: [postgres]
    cmd: node index.js

  postgres:
    image: postgres:16-alpine
    ports: [5432]

tasks:
  install:
    image: node:alpine
    cmds:
      - npm ci
```

## Starting and stopping services
Services start and stop automatically based on the needs of the tasks you run.
They can also be controlled directly with the cli:

* `hammerkit up` starts the services.
* `hammerkit down` stops the services.

This is useful to keep shared services such as a database running across multiple
task runs.

{% hint style="info" %}
A service's container is recreated when it starts, so data written inside it is
lost on the next start unless you attach a [volume](container.md#volumes).
Declare a volume to persist a database's data — or to seed/back it up with
[store / restore](../cli/store-restore.md).
{% endhint %}
