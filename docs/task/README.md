---
description: >-
  A task a piece of work with dependencies, that requires input files and
  generates output files.
---

# Task
Tasks are pieces of work that you need to build or development your project.

The minimal task just contains a list of commands.
```yaml
tasks:
  example:
    cmds:
      - echo "minimal example"
```

## Source
Tasks that depend on input files should specify them as a `source`.
Hammerkit will detect if the task sources have changed compared to previous runs and skip execution if they are unchanged.

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

## Generate
Tasks that generate output files should specify them as a `generate`.
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
