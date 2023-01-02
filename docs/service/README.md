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
