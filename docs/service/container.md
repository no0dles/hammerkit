---
description: >-
A service is a continous task that does not end.
Something a task may require a service to perform.
---

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
