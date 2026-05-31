---
description: When a task should run in a container and when it should run on the host.
---

# Local vs. container tasks

The single rule, restated: **a task with an `image` runs in a container; a task
without one runs on your host.** Everything else — `src`, `generates`, `deps`,
`needs`, caching — behaves the same either way. This guide is about *choosing*
between them.

## Prefer containers

Containers are the recommended default, and the reason hammerkit exists:

* **No local tooling.** The compiler, SDK, CLI — all come from the image. Nobody on
  the team installs Node, .NET, Helm or the AWS CLI; they just need a container
  engine.
* **Repeatable everywhere.** The build behaves identically on every laptop and
  every CI runner, because it's the same image. No "works on my machine".
* **Per-task images.** Each task can use a *different* image, so you don't maintain
  one giant build image with every tool in it.
* **Isolation.** Only declared `src`/`generates`/`mounts` are visible, so side
  effects are contained.

```yaml
tasks:
  build:
    image: node:22-alpine   # tools come from here
    src:
      - src
    cmds:
      - npm run build
```

## When a local task makes sense

Drop the `image` to run on the host when:

* the tool **can't** run in a container here — it needs host hardware or a platform
  SDK (Xcode on macOS, signing tools, a local GPU);
* you're calling something every developer already has and containerizing adds no
  value;
* you're driving the host's own container engine or `kubectl` and want host
  credentials/context.

```yaml
tasks:
  package-ios:
    platform:
      os: macos
    cmds:
      - xcodebuild ...
```

A local task can declare a [`platform`](../build-file/reference.md#task) so
hammerkit only runs it where it's supported — useful in a CI matrix. Use
[labels](../labels/README.md) to route such tasks to the right runner (a macOS host
for iOS, Linux for the rest).

## Mixing them

You can freely mix: a local task can depend on a container task and vice versa.
Sources and outputs of a container task's dependencies are mounted in automatically,
so the chain stays consistent. A local task that `needs` a service gets the
connection details as [environment hints](../service/README.md#environment-hints-for-local-tasks),
since it isn't on the container network.
