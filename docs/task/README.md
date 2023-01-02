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
