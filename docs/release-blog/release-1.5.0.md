# Release 1.5.0 (comming soon)

A short retro about the made changes and findings

## Services
Services have been added to assist your tasks.
They can be used to startup databases and other service applications and get attached to the task if needed.

They are similar to tasks but usually are continuously running in the background.  
Executing tasks that require a service, will trigger a service to start.
As soon as they are ready the task can execute.
When there are no pending tasks left that need the service, they will be terminated.

There are two types of services hammerkit supports:

### Container Services
Similar to [docker-compose](https://docs.docker.com/compose/) but offer some further advantages:

- Ensure services are ready before your tasks uses them with healthchecks.
- Automatic dns resolution between container task and services
- Dynamic start/termination of services depending on the need
- Watch mode for automated restarts on file mounts changes

```
services:
  postgres:
    image: postgres
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

### Kubernetes services
Use `kubectl port-forward` to connect pods, services and deployments from kubernetes to your task.
Enabling easy integration with staging/development environments and offload the need to run everything on one machine.

```
services:
  postgres:
    context: staging
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres

tasks:
  api:
    image: node
    needs: [postgres]
    cmds:
      - node index.js

```

## Labels
Labels got added to categorize tasks and services.
Allowing to group or divide tasks from each other.

The cli commands [exec](../cli/execute.md), [store/restore](../cli/store-restore.md), [clean](../cli/clean.md), [validate](../cli/validate.md) and [ls](../cli/ls.md) support label arguments to limit the scope.

The new `--filter, -f` option allows to reduce to scope to tasks/services only matching the specified label.
For example `task clean --filter project=a` will only run the clean command on tasks that have the label `project=a` or are a dependency of such a task.

The other new `--exclude, -e` option works the opposite way and reduces the scope to task/services that do not have a matching label.
For example `task -e project=a` will execute all tasks that do not have a label `project=a`.

Further examples and uses cases can be found [here](../labels/README.md).

## CLI start performance
The cli responsiveness has been improved by reading tasks and service definition as late as possible.
Before the build file was parsed on startup including all references/includes.
This was needed for the preparation of the cli and help page that displayed all available tasks. 

With the new redesign it's not needed until the moment of execution of a specific task or the new [ls command](../cli/ls.md).
