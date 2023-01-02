# Container service
Container services run in the same network as the other container tasks.
By default they are started when needed from by a task and stopped when no longer needed by future tasks.

## Differences to docker-compose
Services are similar to a `docker compose`, but are better integrated with your tasks.
Compared to [docker compose v3](https://docs.docker.com/compose/compose-file/) the container service lacks a lot of features.
There are some aspects to container services, that should still make them more appealing.

### Seamless integration
Hammerkit is aware of the task dependency tree and can make decisions about the lifetime of a service.
Depending on your setup, this can result in less cpu/memory usage in general.

It ensures simplicity and reduces the need for another tool that needs to be started and awaited, before you can run your task.

### Reusage
Services can be included or references similar to tasks.
This makes it possible to reuse services and their state for multiple hammerkit files/projects.

Making it possible to run just one database for multiple projects and reducing required cpu/memory. 

### Store/Restore
The [store/restore](./cli/store-restore.md) command from the hammerkit cli can be used for services as well.
Enabling the functionality to export / import volume data of services.

This can be used to seed database data or backup and restore project data states.

## Ports
Services can expose ports to the host machine.
They can be useful to debug/connect a service.

{% hint style="warning" %}
They are not required for tasks. 
Task are in the same network as services and have access to all ports.
{% endhint %}

```yaml
services:
  postgres:
    image: postgres:12-alpine
    ports:
      - 5432:5432
```

## Healthcheck
Healthcheck do check if the service is ready to be used.
Tasks will only start if a needed service's is running and healthcheck passed if present.

A healthcheck requires a command that can be used to test the readiness of a service.
The command is executed inside of the service container. 
To pass the healtcheck the command needs to return with an exit code of `0`.

The following example contains a postgres service. 
It uses the `pg_isready` executable in a healthcheck.
This ensures the postgres server is ready to accept connections. 
 
```yaml
services:
  postgres:
    image: postgres:12-alpine
    healthcheck:
      cmd: "pg_isready -U postgres"
```

{% hint style="warning" %}
Without a healthcheck a task may get started before the service is ready. 
{% endhint %}

## Volumes
Services start and stop depending on needs of tasks. 
In order to persist data over restarts volumes are needed to keep state.

```yaml
services:
  postgres:
    image: postgres:12-alpine
    volumes:
      - "postgres-db:/var/lib/postgresql/data"
```

## Mounts
Mounts can be used to pass local files into the container.
They allow to mount local configuration and settings files.

{% hint style="warning" %}
Mounts are not recommended for frequently changing files. 
Syncing large directories on macOS/Windows requires a lot of CPU usage.
{% endhint %}


```yaml
services:
  postgres:
    image: postgres:12-alpine
    mounts:
      - "./postgres.conf:/etc/postgresql/postgresql.conf"
```
