---
description: >-
  A task a piece of work with dependencies, that requires input files and
  generates output files.
---

# Task
Tasks are pieces of work that you need to build or develop your project.

The minimal task just contains a list of commands.
```yaml
tasks:
  example:
    cmds:
      - echo "minimal example"
```

{% hint style="info" %}
**Local vs. container — the one rule to remember.** If a task declares an `image`,
its commands run **inside that container**. If it has no `image`, they run
**directly on your host** using the tools installed there. Everything else (sources,
outputs, caching, dependencies) works the same in both cases. Containers are the
recommended default: they remove the need to install build tools on every machine
and make a build behave identically on your laptop and in CI. See
[run a task in a container](container.md).
{% endhint %}

## Anatomy of a task
A task is built from a small, fixed set of fields:

| Field | Purpose |
|-------|---------|
| `cmds` | The commands to run, in order. |
| `image` | Run the commands inside this container image. Omit to run on the host. |
| `src` | Input files/folders. Used for [caching](caching.md) — unchanged sources let the task be skipped. |
| `generates` | Output files/folders the task produces. These are what gets cached, stored and restored. |
| `deps` | Other tasks that must run first (see [dependencies](dependencies.md)). |
| `needs` | Services that must be running first (see [needs](needs.md)). |
| `mounts` | Extra paths to make available to a container task (see [container](container.md)). |
| `envs` | [Environment variables](../build-file/environment-variables.md) for the commands. |
| `labels` | Group/filter tasks (see [labels](../labels/README.md)). |
| `cache` | The [caching](caching.md) method/backend for this task. |

## Source files (`src`)
Tasks that depend on input files should declare them under `src`.
Hammerkit detects if the `src` files have changed compared to previous runs and skips execution if they are unchanged.

```yaml
tasks:
  build:
    description: "run typescript build"
    src:
      - tsconfig.json
      - src
    cmds:
      - tsc
```

## Generated files (`generates`)
Tasks that produce output files should declare them under `generates`.
Hammerkit can store generated files into archives, which can be used to save and restore build outputs.  

```yaml
tasks:
  build:
    description: "run typescript build"
    src:
      - tsconfig.json
      - src
    generates:
      - dist
    cmds:
      - tsc
```

### Exporting generated files
By default generated files of a container task stay inside the container volume.
Mark a generate with `export: true` to copy it back into your workspace after the
task ran. This is useful when another tool outside hammerkit needs the produced
files, for example a build artifact you want to inspect or publish.

```yaml
tasks:
  build:
    image: node:alpine
    generates:
      - path: dist
        export: true
    cmds:
      - tsc -b
```

### Resetting generated files on change
By default a generated directory keeps its contents between runs, so a re-run can
reuse previous output. Mark a generate with `resetOnChange: true` to wipe it
before the task runs again, guaranteeing the task starts from an empty output
directory and no stale files from a previous run remain.

```yaml
tasks:
  bundle:
    image: node:alpine
    generates:
      - path: dist
        resetOnChange: true
    cmds:
      - node bundle.js
```
