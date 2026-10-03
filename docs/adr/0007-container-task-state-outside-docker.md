# 0007: A container task's state record lives in the hammerkit directory, not in a paused container

A successful container task used to leave its container behind, paused, as the record of which state key its outputs belong to (`hammerkit-state` label, read by `currentStateKey`). Now the container is always removed when the task ends, and the record is a file, `<hammerkit directory>/state/<instance id>`, holding the state key — the same idea as a local task's `.hammerkit/<id>` file.

Like before, the record is removed before a task runs and only written after it succeeded, and `currentStateKey` still requires the outputs (volumes, exported directories, file outputs) to exist, so a pruned volume is still a miss.

## Why

- Every task a project ever ran sat in `docker ps` as a paused container, holding memory, pinning its image and its volumes, and blocking `docker volume rm` of its outputs. On small CI and Coder disks they piled up with each changed task id.
- A paused container counted as "running" for `initialize`, so a leftover record could look like a concurrent run.

## Considered options

- **Keep a created-but-never-started container as the record** — rejected: still a container per task in `docker ps -a`, still pins image and volumes.
- **Record in the project's `.hammerkit` folder** like local tasks — rejected: writing into the project after a task can change another task's `src` when that folder is inside it; the hammerkit directory is outside every project, and the instance id already scopes the record to one checkout (ADR 0006).

## Consequences

- Upgrading is one cache miss per container task (the old label is not read); the paused records of older versions are removed the next time their task runs (`usingContainer` removes non-running containers of the item) or by `hammerkit clean`.
- The record is on the machine running hammerkit while volumes are on the docker host. With a remote `DOCKER_HOST` switched to another daemon, the output check turns the stale record into a miss.
- Containers carry `hammerkit-host` (and services `hammerkit-daemon`) next to `hammerkit-pid`, so `clean` can remove containers of killed runs on this machine without touching other machines' or `up --daemon` services.
